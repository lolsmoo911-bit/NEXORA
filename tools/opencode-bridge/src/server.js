import { createServer } from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { config, SCOPES } from './config.js';
import { proxyManager } from './proxy-manager.js';
import { EventLog } from './events.js';
import { audit } from './audit.js';
import { captureScreenshot } from './screenshot.js';
import { isHighRiskCommand } from './guards.js';
import { searchText, withinRoots, WorkspaceError, workspaceRoots } from './workspace.js';
import {
  authenticateRequest,
  describe as describeAuth,
  handleAuthRoutes,
  mcpAuthChallenge,
} from './auth.js';
import {
  OpencodeError,
  activeSessions,
  createSession,
  fsFind,
  fsList,
  fsRead,
  getMessages,
  getSession,
  interrupt,
  listSessions,
  progressSince,
  sendPrompt,
  serviceInfo,
  sessionDiff,
  shellCreate,
  shellGet,
  shellList,
  shellOutput,
  fsWrite,
  waitForAssistant,
  waitForShell,
} from './opencode.js';
import {
  clamp,
  formatDate,
  formatEvents,
  formatFileSize,
  formatSessions,
  formatTranscript,
} from './format.js';

// --- persistent on-disk console log (WinSW stdout capture rotates aggressively; keep a readable copy) ---
const LOG_FILE = join(process.cwd(), '.service', 'bridge-console.log');
const _logToDisk = (args) => {
  try {
    const text = args.map((item) => {
      if (typeof item === 'string') return item;
      if (item instanceof Error) return item.stack || String(item);
      let json;
      try { json = JSON.stringify(item); } catch { json = undefined; }
      return json ?? String(item);
    }).join(' ');
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${text}\n`);
  } catch {}
};
const _consoleLog = console.log.bind(console);
console.log = (...args) => { _consoleLog(...args); _logToDisk(args); };
const _consoleWarn = console.warn.bind(console);
console.warn = (...args) => { _consoleWarn(...args); _logToDisk(['[warn]', ...args]); };
const _consoleError = console.error.bind(console);
console.error = (...args) => { _consoleError(...args); _logToDisk(['[error]', ...args]); };

const events = new EventLog();
const transports = new Map();
const startedAt = Date.now();

function directoryFrom(args) {
  return args?.directory || config.directory || undefined;
}

function absolutePath(locationDirectory, entryPath) {
  if (!locationDirectory) return entryPath;
  if (entryPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entryPath)) return entryPath;
  return join(locationDirectory, entryPath);
}

function register(server, name, definition, handler) {
  server.registerTool(name, definition, async (args) => {
    const start = Date.now();
    try {
      const result = await handler(args ?? {});
      console.log(`[tool] ${name} ok (${Date.now() - start} ms)`);
      await audit({ tool: name, args, status: 'ok', durationMs: Date.now() - start });

      // Handlers may pass through native MCP content blocks (images, isError, ...).
      if (result && typeof result === 'object' && Array.isArray(result.content)) return result;

      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: 'text', text: text.slice(0, 60_000) }] };
    } catch (error) {
      const message = error instanceof OpencodeError || error instanceof WorkspaceError
        ? error.message
        : error?.message || String(error);
      console.error(`[tool] ${name} error: ${message}`);
      await audit({ tool: name, args, status: 'error', error: message, durationMs: Date.now() - start });
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  });
}

/** Collect every message page of a session (bounded by maxTotal). */
async function collectMessages(sessionId, { pageSize = 120, maxTotal = 1000, order = 'desc' } = {}) {
  const all = [];
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const result = await getMessages(sessionId, { limit: pageSize, order: cursor ? undefined : order, cursor });
    all.push(...result.messages);
    cursor = result.cursor?.next;
    if (!cursor || all.length >= maxTotal) break;
  }
  return all;
}

/** Gather image attachments from user prompts (inline base64) and tool file parts (metadata). */
async function collectImageAttachments(sessionId) {
  const messages = await collectMessages(sessionId);
  const images = [];
  for (const message of messages) {
    if (message.type === 'user' && Array.isArray(message.files)) {
      message.files.forEach((file, index) => {
        if (typeof file.mime === 'string' && file.mime.startsWith('image/')) {
          images.push({
            index: images.length,
            origin: 'user-attachment',
            message_id: message.id,
            position: index,
            name: file.name || 'attachment',
            mime: file.mime,
            inline_data: Boolean(file.data),
            source: file.source?.type === 'uri' ? file.source.uri : 'inline',
            description: file.description || (message.text || '').slice(0, 120),
            time: message.time?.created,
          });
        }
      });
    }
    if (message.type === 'assistant') {
      for (const part of message.content || []) {
        if (part.type !== 'tool') continue;
        for (const item of part.state?.content || []) {
          if (item.type === 'file' && typeof item.mime === 'string' && item.mime.startsWith('image/')) {
            images.push({
              index: images.length,
              origin: 'tool-file',
              message_id: message.id,
              tool: part.name,
              name: item.name || item.uri || 'tool artifact',
              mime: item.mime,
              uri: item.uri,
              inline_data: false,
              time: message.time?.created,
            });
          }
        }
      }
    }
  }
  return images.sort((a, b) => (a.time || 0) - (b.time || 0)).map((entry, index) => ({ ...entry, index }));
}

function safeTime(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function buildServer({ write = false, shell = false, screenshot = false } = {}) {
  const server = new McpServer(
    { name: 'opencode-bridge', version: '0.2.0' },
    {
      instructions: [
        'This server exposes a live OpenCode coding agent running on the user\'s own computer.',
        'Use opencode_list_sessions to discover sessions, then opencode_get_session to read a transcript that includes every shell command, file edit, and tool output. Transcripts are paginated: use the returned cursor to fetch older or newer pages.',
        'Session IDs always start with "ses_". Never invent a session ID, file path, or file content: list or read it first.',
        write
          ? 'Write access is granted for this connection: opencode_send_message can send a new instruction to the agent, opencode_interrupt_session can stop a running agent.'
          : 'This connection is READ-ONLY: no agent instructions can be sent.',
        shell
          ? 'Shell access is granted: opencode_shell_run executes one terminal command on the user\'s machine (high-risk commands additionally require confirm=true) and opencode_shell_get reads its status/output.'
          : 'No direct shell access on this connection.',
        screenshot
          ? 'Screenshot capture is granted: opencode_screenshot returns the current primary display as an image (only when the user explicitly asks).'
          : 'No screenshot access on this connection.',
        'opencode_list_images / opencode_get_image expose conversation image attachments; opencode_search_text searches file contents.',
        'Prefer opencode_recent_events to see what is happening right now, and opencode_session_diff to see file changes.',
        'Never claim a task is complete without reading the actual reply or shell output. When the agent is still running, report progress and re-check instead of guessing.',
      ].join(' '),
    },
  );

  register(
    server,
    'opencode_list_sessions',
    {
      title: 'List OpenCode sessions',
      description:
        'List recent OpenCode coding sessions on the user\'s machine, newest first. Use this when the user asks what OpenCode is working on, or to find a session ID before reading it. Returns session ID, last update time, running/idle state, project directory, and title.',
      inputSchema: {
        search: z.string().optional().describe('Optional text to filter session titles.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum sessions to return (default 10).'),
        directory: z.string().optional().describe('Project directory to scope the list to. Omit to use the bridge default.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const [sessions, active] = await Promise.all([
        listSessions({ search: args.search, limit: args.limit ?? 10, directory: directoryFrom(args) }),
        activeSessions().catch(() => ({})),
      ]);
      if (!sessions.length) return 'No sessions found.';
      return `${sessions.length} session(s):\n${formatSessions(sessions, active)}`;
    },
  );

  register(
    server,
    'opencode_active_sessions',
    {
      title: 'List running OpenCode sessions',
      description:
        'List OpenCode sessions that are currently executing (agent loop running right now). Use this to check whether the coding agent is busy before sending new work.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const active = await activeSessions();
      const ids = Object.keys(active);
      if (!ids.length) return 'No OpenCode session is currently running.';
      const all = await listSessions({ limit: 50 });
      const byId = new Map(all.map((session) => [session.id, session]));
      const lines = ids.map((id) => (byId.has(id) ? `- ${id} | RUNNING | ${byId.get(id).title || '(untitled)'}` : `- ${id} | RUNNING`));
      return `Running now:\n${lines.join('\n')}`;
    },
  );

  register(
    server,
    'opencode_get_session',
    {
      title: 'Read an OpenCode session transcript',
      description:
        'Read the transcript of one OpenCode session: user instructions, assistant text, every shell/terminal command, every file read/write/edit tool call with its input and output, plus timestamps and completion status. This is the main tool for seeing exactly what the OpenCode agent is doing. When the response reports a next_cursor, call this tool again with cursor=... and direction=older to continue reading history.',
      inputSchema: {
        session_id: z.string().describe('Session ID starting with "ses_". Get it from opencode_list_sessions.'),
        limit: z.number().int().min(1).max(120).optional().describe('Messages per page (default 40).'),
        cursor: z.string().optional().describe('Opaque pagination cursor returned by a previous call.'),
        direction: z.enum(['older', 'newer']).optional().describe('Which page to fetch with cursor (default older).'),
        include_tools: z.boolean().optional().describe('Include tool calls (commands and file operations). Default true.'),
        include_reasoning: z.boolean().optional().describe('Include short reasoning summaries shown by the model. Default false.'),
        tool_output_chars: z.number().int().min(100).max(20_000).optional().describe('Maximum characters of each tool output (default 1200).'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const session = await getSession(args.session_id);
      const active = await activeSessions().catch(() => ({}));
      const page = await getMessages(args.session_id, {
        limit: args.limit ?? 40,
        cursor: args.cursor,
        order: args.direction === 'newer' && args.cursor ? undefined : 'desc',
      });
      const messages = page.messages;
      const model = session?.model ? `${session.model.providerID}/${session.model.id}` : '?';
      const header = [
        `Session ${session.id}`,
        `title: ${session.title || '(untitled)'}`,
        `directory: ${session.location?.directory || '?'}`,
        `agent: ${session.agent || '?'} | model: ${model} | state: ${active[session.id] ? 'RUNNING' : 'idle'}`,
        `updated: ${formatDate(session.time?.updated)} | messages shown: ${messages.length}`,
      ].join('\n');

      const transcript = formatTranscript(messages, {
        includeTools: args.include_tools !== false,
        includeReasoning: args.include_reasoning === true,
        maxOutput: args.tool_output_chars ?? 1200,
      });

      const older = page.cursor?.next;
      const newer = page.cursor?.previous;
      const paging = [
        older ? `older page cursor: ${older}` : 'no older pages',
        newer ? `newer page cursor: ${newer}` : 'no newer pages',
      ].join(' | ');
      return `${header}\n\n--- transcript (oldest first) [${paging}] ---\n${clamp(transcript, 40_000)}`;
    },
  );

  register(
    server,
    'opencode_session_diff',
    {
      title: 'Show file changes made by a session',
      description:
        'Show the file diff (patch, additions, deletions) produced by the latest turn of an OpenCode session. Use this to see which files the agent changed and how.',
      inputSchema: {
        session_id: z.string().describe('Session ID starting with "ses_".'),
        context: z.number().int().min(0).max(50).optional().describe('Unchanged context lines around each hunk. Omit for full patches.'),
        max_patch_chars: z.number().int().min(200).max(50_000).optional().describe('Maximum characters per file patch (default 4000).'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const files = await sessionDiff(args.session_id, { context: args.context });
      if (!files.length) return 'This session has no file changes in its latest turn.';
      const budget = args.max_patch_chars ?? 4000;
      return files
        .map((file) => {
          const stats = `${file.status}, +${file.additions} -${file.deletions}`;
          return `### ${file.file} (${stats})\n${clamp(file.patch || '(no patch)', budget)}`;
        })
        .join('\n\n');
    },
  );

  register(
    server,
    'opencode_recent_events',
    {
      title: 'Read live OpenCode events',
      description:
        'Read the most recent live events from the OpenCode event stream (session updates, tool calls, shell commands, permissions, file changes). Use this to see what the agent is doing right now. Events are captured in a small in-memory buffer while the bridge is running.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Number of recent events to return (default 30).'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const recent = events.recent(args.limit ?? 30);
      const status = events.running
        ? `stream: connected | buffered: ${events.size}`
        : `stream: disconnected${events.lastError ? ` (${events.lastError})` : ''}`;
      return `${status}\n\n${formatEvents(recent)}`;
    },
  );

  register(
    server,
    'opencode_read_file',
    {
      title: 'Read a file from the OpenCode workspace',
      description:
        'Read a text file from the user\'s machine through the OpenCode filesystem API. Use absolute paths or paths relative to the workspace directory. Only approved workspace directories are accessible. Always read a file before describing or editing it.',
      inputSchema: {
        path: z.string().describe('Absolute path (C:/Users/...) or path relative to the workspace directory.'),
        directory: z.string().optional().describe('Workspace directory used to resolve relative paths.'),
        max_chars: z.number().int().min(200).max(200_000).optional().describe('Maximum characters to return (default 40000).'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const target = withinRoots(args.path, { directory: directoryFrom(args) });
      const { buffer, contentType } = await fsRead({ path: target });
      if (buffer.includes(0)) {
        return `${args.path} (${formatFileSize(buffer.length)}, ${contentType}) looks binary; not shown. Use opencode_get_image for picture attachments.`;
      }
      const text = buffer.toString('utf8');
      return `${args.path} (${formatFileSize(buffer.length)})\n\n${clamp(text, args.max_chars ?? 40_000)}`;
    },
  );

  register(
    server,
    'opencode_list_files',
    {
      title: 'List a workspace directory',
      description:
        'List the direct children (files and directories) of a directory in the OpenCode workspace. Use it to explore the project before reading files.',
      inputSchema: {
        path: z.string().optional().describe('Directory to list. Defaults to the workspace directory.'),
        directory: z.string().optional().describe('Workspace directory used to resolve relative paths.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { entries, location } = await fsList({ path: args.path, directory: directoryFrom(args) });
      const where = args.path || location?.directory || 'workspace';
      if (!entries.length) return `${where}: empty directory.`;
      const lines = entries
        .map((entry) => `${entry.type === 'directory' ? 'd' : 'f'}  ${absolutePath(location?.directory, entry.path)}`)
        .sort();
      return `${where} (${entries.length} entries)\n${lines.join('\n')}`;
    },
  );

  register(
    server,
    'opencode_find_files',
    {
      title: 'Find files in the workspace',
      description:
        'Search recursively for files or directories by name in the OpenCode workspace. Use this to locate a file when you do not know its exact path.',
      inputSchema: {
        query: z.string().describe('File or directory name fragment to search for.'),
        type: z.enum(['file', 'directory']).optional().describe('Restrict results to files or directories.'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default 30).'),
        directory: z.string().optional().describe('Workspace directory to search in.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { entries, location } = await fsFind({
        query: args.query,
        directory: directoryFrom(args),
        limit: args.limit ?? 30,
        type: args.type,
      });
      if (!entries.length) return `No matches for "${args.query}" in ${location?.directory || 'workspace'}.`;
      return entries
        .map((entry) => `${entry.type === 'directory' ? 'd' : 'f'}  ${absolutePath(location?.directory, entry.path)}`)
        .join('\n');
    },
  );

  register(
    server,
    'opencode_search_text',
    {
      title: 'Search file contents in the workspace',
      description:
        'Search for a text (or regular expression) inside files of an approved workspace directory. Skips node_modules/.git/build directories and binary files; bounded at 4000 files. Use this instead of running grep to find where something lives.',
      inputSchema: {
        query: z.string().describe('Text or regular expression to search for.'),
        directory: z.string().optional().describe('Workspace directory to search (must be inside the approved roots).'),
        regex: z.boolean().optional().describe('Treat the query as a regular expression (default false).'),
        case_sensitive: z.boolean().optional().describe('Case-sensitive search (default false).'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum matches (default 50).'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await searchText({
        query: args.query,
        directory: args.directory || directoryFrom(args) || '.',
        regex: args.regex === true,
        caseSensitive: args.case_sensitive === true,
        limit: args.limit ?? 50,
      });
      if (!result.matches.length) {
        return `No matches for "${args.query}" in ${result.root} (scanned ${result.scanned} text files).`;
      }
      const lines = result.matches
        .slice(0, args.limit ?? 50)
        .map((match) => `${match.file}:${match.line}: ${match.text.trim()}`);
      return [
        `${result.matches.length} match(es) in ${result.root}${result.truncated ? ' (results truncated)' : ''}`,
        ...lines,
      ].join('\n');
    },
  );

  register(
    server,
    'opencode_list_images',
    {
      title: 'List image attachments in a session',
      description:
        'List the images that appear in an OpenCode session: files the user attached to prompts (stored inline, retrievable as picture data) and image artifacts produced by tools. Returns metadata (index, message id, name, mime type) — use opencode_get_image to fetch the actual picture.',
      inputSchema: {
        session_id: z.string().describe('Session ID starting with "ses_".'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const images = await collectImageAttachments(args.session_id);
      if (!images.length) {
        return 'No image attachments in this session. (Non-image file attachments appear in the transcript only.)';
      }
      const lines = images.map((image) =>
        [
          `#${image.index}`,
          `${image.origin === 'user-attachment' ? 'attached by user' : `from tool ${image.tool || '?'}`}`,
          `message ${image.message_id}`,
          `${image.name}`,
          `${image.mime}`,
          image.inline_data ? 'retrievable (opencode_get_image index=' + image.index + ')' : 'metadata only (uri in transcript)',
          image.description ? `about: ${image.description.replace(/\s+/g, ' ').slice(0, 80)}` : '',
        ]
          .filter(Boolean)
          .join(' | '),
      );
      return `${images.length} image(s):\n${lines.join('\n')}`;
    },
  );

  register(
    server,
    'opencode_get_image',
    {
      title: 'Fetch an image attachment as picture data',
      description:
        'Return an image from an OpenCode session as a real MCP image block (displayable picture, not base64 text). Use index from opencode_list_images. User attachments carry inline data; tool artifacts are fetched from disk when their file URI is inside the approved workspace.',
      inputSchema: {
        session_id: z.string().describe('Session ID starting with "ses_".'),
        index: z.number().int().min(0).optional().describe('Attachment index from opencode_list_images.'),
        message_id: z.string().optional().describe('Alternatively, the owning message ID with position.'),
        position: z.number().int().min(0).optional().describe('Attachment position inside that message.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const images = await collectImageAttachments(args.session_id);
      if (!images.length) return { content: [{ type: 'text', text: 'No image attachments in this session.' }] };
      const image = images[args.index ?? 0];
      if (!image) return { content: [{ type: 'text', text: `No attachment at index ${args.index ?? 0}. Highest index: ${images.length - 1}.` }] };

      if (image.origin === 'user-attachment') {
        const messages = await collectMessages(args.session_id);
        const message = messages.find((entry) => entry.id === image.message_id);
        const file = message?.files?.[image.position ?? 0];
        if (!file?.data) {
          return { content: [{ type: 'text', text: `Image metadata found but its inline data is missing (message ${image.message_id}).` }] };
        }
        return {
          content: [
            { type: 'image', data: file.data, mimeType: file.mime || image.mime },
            { type: 'text', text: `Image: ${image.name} (${image.mime}) from message ${image.message_id}${image.description ? ` — ${image.description}` : ''}` },
          ],
        };
      }

      // tool-file artifact: resolve its file:// URI (or plain path) and load it.
      const uri = image.uri || '';
      let filePath = null;
      if (uri.startsWith('file://')) {
        try {
          filePath = decodeURIComponent(new URL(uri).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
        } catch {
          filePath = null;
        }
      } else if (/^[A-Za-z]:[\\/]/.test(uri)) {
        filePath = uri;
      }
      if (!filePath) {
        return {
          content: [{ type: 'text', text: `This artifact is referenced as "${uri}" and its raw bytes are not exposed by OpenCode; only metadata is available here.` }],
        };
      }
      const target = withinRoots(filePath, { forWrite: false });
      const { buffer } = await fsRead({ path: target });
      return {
        content: [
          { type: 'image', data: buffer.toString('base64'), mimeType: image.mime },
          { type: 'text', text: `Image artifact: ${image.name} (${image.mime}) at ${target}` },
        ],
      };
    },
  );

  if (screenshot) register(
    server,
    'opencode_screenshot',
    {
      title: 'Capture a screenshot of the primary screen',
      description:
        'Capture the current primary display as a PNG and return it as a real MCP image block. Only for when the user explicitly asks to see the screen. Runs on demand — never in the background. Requires the bridge screenshot capability.',
      inputSchema: {
        confirm: z.boolean().optional().describe('Set true to confirm capturing the user\'s screen now.'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      if (args.confirm !== true) {
        return {
          content: [{ type: 'text', text: 'Screenshot refused: pass confirm=true after the user explicitly asks to see the screen.' }],
        };
      }
      const shot = await captureScreenshot();
      return {
        content: [
          { type: 'image', data: shot.data, mimeType: shot.mimeType },
          { type: 'text', text: `Primary screen captured at ${formatDate(Date.now())} (${formatFileSize(shot.bytes)}, PNG).` },
        ],
      };
    },
  );

  register(
    server,
    'opencode_proxy_status',
    {
      title: 'Check OpenCode-only WARP proxy status',
      description: 'Read-only status of Cloudflare WARP installation, its local proxy endpoint, TLS-verified HTTPS reachability, and OpenCodeAgent proxy configuration. Values and credentials are never returned.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => proxyManager.status(),
  );

  if (write) {
    register(
      server,
      'opencode_proxy_enable',
      {
        title: 'Configure WARP proxy for OpenCode only',
        description: 'After WARP Local Proxy is installed and TLS-verified at 127.0.0.1:40000, configure only the OpenCodeAgent service XML. Does not restart services. Never use this tool to react to provider HTTP 429 or account quota limits.',
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async () => proxyManager.enable(),
    );
    register(
      server,
      'opencode_proxy_disable',
      {
        title: 'Remove Bridge-managed OpenCode proxy settings',
        description: 'Remove or restore only proxy entries previously managed by this Bridge. Does not restart services.',
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async () => proxyManager.disable(),
    );
  }

  if (write) register(
    server,
    'opencode_send_message',
    {
      title: 'Send an instruction to OpenCode',
      description:
        'Send a new instruction to the OpenCode coding agent and optionally wait for its reply. Creates a new session when session_id is omitted. This tool runs real commands and edits real files on the user\'s machine, so only use it when the user explicitly asks you to make OpenCode do something.',
      inputSchema: {
        text: z.string().describe('The instruction to send to the OpenCode agent.'),
        session_id: z.string().optional().describe('Existing session ID. Omit to create a new session. Never reuse another chat\'s session.'),
        title: z.string().optional().describe('Title for a newly created session.'),
        directory: z.string().optional().describe('Workspace directory for a newly created session.'),
        wait_seconds: z.number().int().min(0).max(300).optional().describe('How long to wait for the reply, in seconds. 0 = do not wait (default 60).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => {
      let sessionId = args.session_id;
      let created = false;
      if (!sessionId || !sessionId.startsWith('ses_')) {
        if (sessionId) throw new Error('session_id must be an existing OpenCode session ID (ses_...). Omit it to create a new session.');
        const session = await createSession({ title: args.title, directory: directoryFrom(args) });
        sessionId = session.id;
        created = true;
      } else {
        await getSession(sessionId); // 404 → honest error instead of writing into a wrong session
      }

      const startedAtMs = Date.now();
      await sendPrompt(sessionId, args.text, { directory: created ? directoryFrom(args) : undefined });

      const waitSeconds = args.wait_seconds ?? 60;
      if (waitSeconds === 0) {
        return `Instruction sent to session ${sessionId}${created ? ' (new session)' : ''}. Not waiting for a reply. Use opencode_get_session or opencode_recent_events to follow up — this does NOT mean the task is done.`;
      }

      const reply = await waitForAssistant(sessionId, startedAtMs - 1000, waitSeconds * 1000);
      if (!reply) {
        const progress = await progressSince(sessionId, startedAtMs - 1000).catch(() => null);
        const detail = progress && progress.toolCalls
          ? ` Activity so far: ${progress.toolCalls} tool call(s)${progress.tools.length ? ` (${progress.tools.join(', ')})` : ''}.`
          : ' The agent may still be thinking.';
        return `Instruction sent to session ${sessionId}${created ? ' (new session)' : ''}; it is STILL RUNNING after ${waitSeconds}s.${detail} Use opencode_get_session with session_id="${sessionId}" to read progress.`;
      }

      const body = formatTranscript([reply], {
        includeTools: true,
        maxOutput: Math.min(config.maxOutput, 2000),
      });
      return `Session ${sessionId}${created ? ' (new session)' : ''} replied:\n\n${body}`;
    },
  );

  if (write) register(
    server,
    'opencode_interrupt_session',
    {
      title: 'Interrupt a running OpenCode session',
      description:
        'Stop the currently running agent loop of one OpenCode session. Use when the user asks to cancel/stop the running task. Reports whether an execution was actually interrupted.',
      inputSchema: {
        session_id: z.string().describe('Session ID starting with "ses_".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      const result = await interrupt(args.session_id);
      const active = await activeSessions().catch(() => ({}));
      const stillRunning = Boolean(active[args.session_id]);
      return `Interrupted: ${result?.interrupted === true ? 'yes' : 'nothing was running in that session'}. State now: ${stillRunning ? 'STILL RUNNING' : 'idle'}.`;
    },
  );

  if (write) register(
    server,
    'opencode_write_file',
    {
      title: 'Create or overwrite a workspace file',
      description:
        'Create or overwrite a text file inside the approved workspace directories. Missing parent directories are created. This performs a real write on the user\'s machine — read the file first and prefer opencode_edit_file for small changes.',
      inputSchema: {
        path: z.string().describe('Absolute path or path relative to the workspace directory.'),
        content: z.string().describe('Full text content to write.'),
        directory: z.string().optional().describe('Workspace directory used to resolve relative paths.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      const target = withinRoots(args.path, { directory: directoryFrom(args), forWrite: true });
      await fsWrite(target, Buffer.from(args.content ?? '', 'utf8'));
      return `Wrote ${Buffer.byteLength(String(args.content ?? ''), 'utf8')} bytes to ${target}.`;
    },
  );

  if (write) register(
    server,
    'opencode_edit_file',
    {
      title: 'Apply an exact text replacement in a workspace file',
      description:
        'Replace an exact snippet in an existing file inside the approved workspace directories. The find text must match exactly once unless replace_all is set. Returns how many replacements were applied.',
      inputSchema: {
        path: z.string().describe('Absolute path or path relative to the workspace directory.'),
        find: z.string().describe('Exact text to find (must appear exactly once unless replace_all).'),
        replace: z.string().describe('Replacement text.'),
        replace_all: z.boolean().optional().describe('Replace every occurrence (default false).'),
        directory: z.string().optional().describe('Workspace directory used to resolve relative paths.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      const target = withinRoots(args.path, { directory: directoryFrom(args), forWrite: true });
      const { buffer } = await fsRead({ path: target });
      const text = buffer.toString('utf8');
      const count = text.split(args.find).length - 1;
      if (count === 0) throw new Error(`find text not found in ${target}.`);
      if (count > 1 && args.replace_all !== true) {
        throw new Error(`find text appears ${count} times in ${target}; set replace_all=true or use a longer snippet.`);
      }
      const updated = args.replace_all === true ? text.split(args.find).join(args.replace) : text.replace(args.find, args.replace);
      await fsWrite(target, Buffer.from(updated, 'utf8'));
      return `Edited ${target}: ${args.replace_all === true ? count : 1} replacement(s) applied.`;
    },
  );

  if (shell) register(
    server,
    'opencode_shell_run',
    {
      title: 'Run a terminal command on the user\'s machine',
      description:
        'Execute one shell/PowerShell command in a working directory of the user\'s machine through the OpenCode shell API, then return its exit code and output. High-risk commands (deletes, service/registry/driver changes, installs, publishing) are refused unless confirm=true — in that case the user has explicitly approved it.',
      inputSchema: {
        command: z.string().describe('The command line to run.'),
        cwd: z.string().optional().describe('Working directory for the command (inside the approved workspace roots).'),
        timeout_seconds: z.number().int().min(1).max(300).optional().describe('Kill the command after this many seconds (defaults to the bridge shell timeout).'),
        confirm: z.boolean().optional().describe('Set true after the user explicitly approved a high-risk command.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      if (config.shellDangerousConfirm && isHighRiskCommand(String(args.command || '')) && args.confirm !== true) {
        return { content: [{ type: 'text', text: 'This command looks high-risk (destructive/system-level). Not executed: ask the user to approve it, then call again with confirm=true.' }]};
      }
      let cwd;
      if (args.cwd) {
        cwd = withinRoots(args.cwd, { directory: directoryFrom(args) });
      }
      const timeoutSeconds = Math.min(args.timeout_seconds ?? config.shellTimeout, 300);
      const timeoutMs = timeoutSeconds * 1000;
      const info = await shellCreate({
        command: args.command,
        cwd,
        timeout: timeoutMs,
        metadata: { requestedBy: 'bridge-mcp' },
      });
      const final = await waitForShell(info.id, timeoutMs + 10_000);
      const shellInfo = final || info;
      let output = '';
      try {
        const data = await shellOutput(info.id);
        output = data.output || '';
        if (data.truncated && data.cursor !== undefined) {
          const rest = await shellOutput(info.id, { cursor: data.cursor });
          output += rest.output || '';
          if (rest.truncated) output = `${output}\n… output truncated at ${String(output.length)} + remaining chars`;
        }
      } catch (error) {
        output = `(output fetch failed: ${error.message})`;
      }
      const status = shellInfo.status || 'unknown';
      const exit = shellInfo.exit;
      const shown = clamp(output, config.maxOutput);
      return `Command: ${args.command}\ncwd: ${cwd || shellInfo.cwd || 'default'} | shell: ${shellInfo.shell || 'default'} | shell id: ${info.id}\nstatus: ${status}${exit !== undefined && exit !== null ? ` | exit: ${exit}` : ''}${status === 'timeout' ? ' (killed by timeout — output above may be incomplete)' : ''}\n\n--- output ---\n${shown || '(no output)'}`;
    },
  );

  if (shell) register(
    server,
    'opencode_shell_get',
    {
      title: 'Read status and output of a shell run',
      description:
        'Check a command started with opencode_shell_run: current status (running/exited/timeout/killed), exit code, and its output since a cursor position. Use opencode_shell_run first.',
      inputSchema: {
        shell_id: z.string().describe('Shell ID returned by opencode_shell_run.'),
        cursor: z.number().int().min(0).optional().describe('Output cursor from a previous read (read output from there).'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const info = await shellGet(args.shell_id);
      if (!info) return `Unknown shell id ${args.shell_id}.`;
      const data = await shellOutput(args.shell_id, { cursor: args.cursor });
      const clampText = clamp(String(data.output || ''), config.maxOutput);
      const next = data.cursor !== undefined && data.cursor !== null ? `next output cursor: ${data.cursor}` : '';
      return [
        `shell ${args.shell_id} | command: ${info.command}`,
        `status: ${info.status}${info.exit !== undefined && info.exit !== null ? ` | exit: ${info.exit}` : ''} | started: ${formatDate(safeTime(info.time?.started))}${info.time?.completed ? ` | completed: ${formatDate(safeTime(info.time.completed))}` : ' | running'}`,
        `output size: ${data.size ?? 0} bytes${data.truncated ? ' (truncated here)' : ''}${next ? ` | ${next}` : ''}`,
        '',
        clampText || '(no new output)',
      ].join('\n');
    },
  );

  if (shell) register(
    server,
    'opencode_shell_list',
    {
      title: 'List recent shell runs',
      description:
        'List shell commands started through the OpenCode shell API. Note (platform behavior): the underlying API only keeps currently running shells in this list — completed runs disappear from it quickly; read them with opencode_shell_get right after opencode_shell_run instead.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe('Maximum entries (default 15).') },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const shells = (await shellList()).filter((entry) => entry.status === 'running' || Date.now() - (entry.time?.started || 0) < 120_000).slice(0, args.limit ?? 15);
      if (!shells.length) return 'No shell runs recorded (finished runs are dropped from this list by the OpenCode API; use next time: opencode_shell_get with the id from opencode_shell_run).';
      return shells
        .map((entry) =>
          `- ${entry.id} | ${entry.status}${entry.exit !== undefined && entry.exit !== null ? ` (exit ${entry.exit})` : ''} | ${String(entry.command).replace(/\s+/g, ' ').slice(0, 100)} | ${entry.cwd || '?'} | ${formatDate(safeTime(entry.time?.started))}`,
        )
        .join('\n');
    },
  );

  return server;
}

function originOf(req) {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, '');
  const host = req.headers.host || `${config.host}:${config.port}`;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const behindProxy = Boolean(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']);
  const scheme = forwardedProto || (behindProxy ? 'https' : host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  return `${scheme}://${host}`;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function setCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, mcp-session-id, mcp-protocol-version');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-expose-headers', 'mcp-session-id, mcp-protocol-version');
}

// --- hardening: per-client sliding-window rate limit + request size cap ---

const rateBuckets = new Map(); // key → number[] (timestamps)
const RATE_WINDOW_MS = 60_000;

function clientKey(req) {
  return (
    String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim()
  );
}

function rateLimited(req) {
  const key = clientKey(req);
  const now = Date.now();
  let hits = rateBuckets.get(key);
  if (!hits) {
    hits = [];
    rateBuckets.set(key, hits);
  }
  while (hits.length && now - hits[0] > RATE_WINDOW_MS) hits.shift();
  hits.push(now);
  if (rateBuckets.size > 5000) {
    for (const [entryKey, entryHits] of rateBuckets) {
      if (!entryHits.length || now - entryHits[entryHits.length - 1] > RATE_WINDOW_MS) rateBuckets.delete(entryKey);
    }
  }
  return hits.length > config.rateLimitPerMinute;
}

function requestTooLarge(req) {
  const length = Number(req.headers['content-length'] || 0);
  return Number.isFinite(length) && length > config.maxRequestBytes;
}

const HARDENED_PATHS = new Set([config.path, '/', '/token', '/authorize/complete', '/register']);
const SIZE_CHECKED_PATHS = new Set([config.path, '/', '/token', '/authorize/complete', '/register']);

async function handleMcp(req, res) {
  setCors(res);

  const origin = originOf(req);
  const auth = authenticateRequest(req);
  console.log(`[auth] ${req.method} ${req.url.split('?')[0]} host=${req.headers['host'] || '?'} ip=${req.socket?.remoteAddress || '?'} ua="${(req.headers['user-agent'] || '?').slice(0, 90)}" ${req.headers['mcp-session-id'] ? 'sid' : '-'} -> ${auth ? `ok(${auth.clientId})` : `DENIED (${req.headers.authorization ? `bearer len=${req.headers.authorization.length}` : 'NO header'})`}`);
  if (!auth) {
    mcpAuthChallenge(res, origin);
    return;
  }

  if (req.method === 'POST') {
    const sessionId = req.headers['mcp-session-id'];
    let transport = (sessionId ? transports.get(sessionId) : undefined)?.transport;

    if (sessionId && !transport) {
      json(res, 404, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session not found. Re-initialize the MCP connection.' },
        id: null,
      });
      return;
    }

    if (!transport && req.method === 'POST') {
      const capabilities = new Set(auth.scopes || []);
      const options = {
        write: config.allowWrite && capabilities.has(SCOPES.write),
        shell: config.allowShell && capabilities.has(SCOPES.shell),
        screenshot: config.allowScreenshot && capabilities.has(SCOPES.screenshot),
      };
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, { transport });
          console.log(`[mcp] session opened ${id} (scopes: ${auth.scopes.join(' ')})`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const server = buildServer(options);
      await server.connect(transport);
    }

    await transport.handleRequest(req, res);
    return;
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    const sessionId = req.headers['mcp-session-id'];
    const transport = (sessionId ? transports.get(sessionId) : undefined)?.transport;
    if (!transport) {
      json(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Missing or invalid mcp-session-id header.' },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(405, { allow: 'GET, POST, DELETE, OPTIONS' }).end();
}

const httpServer = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      setCors(res);
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (SIZE_CHECKED_PATHS.has(pathname) && requestTooLarge(req)) {
      json(res, 413, { error: 'request too large' });
      return;
    }
    if (HARDENED_PATHS.has(pathname) && rateLimited(req)) {
      res.setHeader('retry-after', '60');
      json(res, 429, { error: 'rate limit exceeded (try again in a minute)' });
      return;
    }

    const origin = originOf(req);
    const handled = await handleAuthRoutes(req, res, pathname, url.searchParams, origin);
    if (handled) return;

    if (pathname === '/health') {
      json(res, 200, {
        ok: true,
        bridge: '0.2.0',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        writeEnabled: config.allowWrite,
        shellEnabled: config.allowShell,
        screenshotEnabled: config.allowScreenshot,
        auth: describeAuth(),
        workspaceRoots: workspaceRoots(),
        eventStream: events.running,
        sessions: transports.size,
      });
      return;
    }

    // ChatGPT's MCP client always addresses the ORIGIN ROOT (it drops the path) — serve MCP there too.
    if (pathname === config.path || pathname === '/') {
      await handleMcp(req, res);
      return;
    }

    console.log(`[http] 404 ${req.method} ${pathname} (host: ${req.headers['host'] || '?'} ip: ${req.socket?.remoteAddress || '?'} ua: ${(req.headers['user-agent'] || '?').slice(0, 90)})`);
    json(res, 404, { error: 'not found' });
  } catch (error) {
    console.error('[http]', error);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else res.end();
  }
});

async function main() {
  let ocInfo = null;
  try {
    ocInfo = await serviceInfo();
  } catch (error) {
    console.warn(`[bridge] OpenCode is not reachable yet: ${error.message}`);
  }

  events.start();

  httpServer.listen(config.port, config.host, () => {
    const local = `http://${config.host}:${config.port}${config.path}`;
    console.log('');
    console.log('  OpenCode <-> ChatGPT bridge v0.2.0');
    console.log('  ----------------------------------');
    console.log(`  MCP endpoint : ${local}`);
    console.log(`  Health       : http://${config.host}:${config.port}/health`);
    console.log(`  OpenCode     : ${ocInfo ? `v${ocInfo.version} (${config.opencodeUrl || 'background service'})` : 'not connected'}`);
    console.log(`  Auth         : ${describeAuth()}`);
    console.log(`  OAuth client : ${config.oauthClientId}`);
    console.log(`  Capabilities : write=${config.allowWrite ? 'on' : 'off'} | shell=${config.allowShell ? 'on' : 'off'} | screenshot=${config.allowScreenshot ? 'on' : 'off'}`);
    console.log(`  Workspace    : ${workspaceRoots().join(' ; ')}`);
    console.log(`  Audit log    : ${config.auditFile}`);
    console.log('');
    console.log('  Expose it with:  cloudflared tunnel --url http://' + config.host + ':' + config.port);
    console.log('');
  });
}

function shutdown(signal) {
  console.log(`\n[bridge] ${signal} received, shutting down...`);
  events.stop();
  for (const { transport } of transports.values()) {
    transport.close().catch(() => {});
  }
  transports.clear();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
  console.error('[bridge] fatal:', error);
  process.exit(1);
});
