/**
 * NEXORA — OpenCode bridge MCP server.
 *
 * Implements the subset of the Model Context Protocol that a ChatGPT custom connector
 * needs over stdio: initialize, tools/list, tools/call, ping. No sampling, no resources,
 * no prompts, no arbitrary code execution.
 *
 * Tool surface (least privilege):
 *   bridge_health            read   - is this bridge and the OpenCode API alive?
 *   nexora_git_status        read   - working tree status of the NEXORA workspace
 *   nexora_diff              read   - bounded diff
 *   nexora_log               read   - bounded recent commits
 *   nexora_docs_index        read   - what reports exist
 *   opencode_list_sessions   read   - sessions on the OpenCode server
 *   opencode_task_status     read   - recent messages of a session
 *   opencode_submit_task     WRITE  - hand a bounded task to the agent
 *   opencode_cancel_task     WRITE  - abort a running session
 */

import { config, validateConfig, redact, safeEndpointLabel } from './config.mjs';
import {
  BridgeError, opencodeHealth, opencodeListSessions, opencodeGetMessages,
  opencodeTaskOutcome, opencodeSubmitTask, opencodeCancelTask, opencodeResolveSession
} from './opencode-client.mjs';
import { nexoraGitStatus, nexoraDiff, nexoraLog, nexoraHeadInfo, nexoraDocsIndex } from './repo.mjs';

// ---------------------------------------------------------------- audit

export function createAudit(sink = null) {
  const records = [];
  const write = (entry) => {
    const rec = { at: new Date().toISOString(), ...entry };
    records.push(rec);
    if (records.length > 500) records.shift();
    if (sink) sink(rec);
    if (config.debug) process.stderr.write('[audit] ' + redact(JSON.stringify(rec)) + '\n');
    return rec;
  };
  return { write, records };
}

// ---------------------------------------------------------------- tools
//
// Tool descriptions follow OpenAI's guidance for custom MCP apps: state *when* to use the
// tool, name its exact inputs, and say what it does not do. On a Business/Enterprise/Edu
// workspace a published app's tool list cannot be edited in place, so these strings are
// part of the deliverable and are reviewed rather than written casually.
//
// Annotations matter for authorisation: ChatGPT respects `readOnlyHint`, and any tool
// without it is treated as a write action that requires confirmation.

/** Server-wide guidance returned in `initialize.instructions`. The first 512 characters
 *  must be self-contained, because that is what some clients surface on their own. */
const INSTRUCTIONS =
  'Read-only inspection of the NEXORA repository and of the OpenCode agent working on it, ' +
  'plus two clearly-marked write tools. Sequence: call bridge_health first to confirm the ' +
  'agent API is reachable; use nexora_git_status / nexora_log / nexora_diff / nexora_docs_index ' +
  'to review work; use opencode_task_status to read the agent output. opencode_submit_task ' +
  'hands a task to the agent and opencode_cancel_task aborts a running one; both change agent ' +
  'state and are never used for inspection. This server cannot execute shell commands, ' +
  'cannot push, and cannot deploy anything.';

export const TOOLS = [
  {
    name: 'bridge_health',
    description: 'Use this FIRST in a session, before anything else. Reports whether this bridge is configured correctly and whether the OpenCode agent API is reachable, healthy, or requires a password. Read-only; changes nothing.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'nexora_git_status',
    description: 'Use this to see what changed in the NEXORA repository: current branch, changed and untracked files, and the HEAD commit. Read-only; runs `git status` only.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'nexora_diff',
    description: 'Use this to read the actual content of a change before approving it. Returns a size-bounded unified diff of the NEXORA workspace. Read-only; runs `git diff` only and cannot write, commit, or push.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'git revision to diff against, default HEAD', default: 'HEAD' },
        staged: { type: 'boolean', description: 'diff the index only', default: false },
        path: { type: 'string', description: 'optional path filter, repository-relative' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'nexora_log',
    description: 'Use this to see recent history of the NEXORA repository: sha, author, date and subject of the last commits. Read-only; runs `git log` only.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      additionalProperties: false
    }
  },
  {
    name: 'nexora_docs_index',
    description: 'Use this to list the files under docs/ so you can tell which phase reports and runbooks exist and which have been verified. Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'opencode_list_sessions',
    description: 'Use this to see which OpenCode sessions exist and which one is most recent, before reading or submitting. Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'opencode_task_status',
    description: 'Use this to check what happened to the most recent task and to read the model\'s actual reply. Returns a derived state - completed, running, persisted_not_run, or unknown - so a task that was stored but never answered is never mistaken for a finished one. Read-only; never sends anything.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'optional session id; defaults to the newest session' } },
      additionalProperties: false
    }
  },
  {
    name: 'opencode_submit_task',
    description: 'Use this to hand a written task to the OpenCode agent working on NEXORA. Blocks until the model has actually produced a reply, and fails loudly if it did not - so a success here means the model ran, not merely that the text was saved. Does not create a session, delete data, push, or deploy.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task text for the agent, in plain language', minLength: 1 },
        sessionId: { type: 'string', description: 'optional session id; defaults to the newest session' }
      },
      required: ['task'],
      additionalProperties: false
    }
  },
  {
    name: 'opencode_cancel_task',
    description: 'Use this only to stop a runaway task. Aborts the running session on the OpenCode server; unsent agent work in that session is discarded. Not needed for normal review.',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'optional session id; defaults to the newest session' } },
      additionalProperties: false
    }
  }
];

// ---------------------------------------------------------------- handlers

export async function callTool(name, args = {}, { audit } = {}) {
  const a = args || {};
  const started = Date.now();
  try {
    let result;
    switch (name) {
      case 'bridge_health': {
        const cfgCheck = validateConfig();
        const api = await opencodeHealth();
        result = {
          bridge: 'nexora-opencode-bridge',
          bridgeConfigValid: cfgCheck.ok,
          configProblems: cfgCheck.problems,
          workspaceRoot: config.workspaceRoot,
          opencodeEndpoint: safeEndpointLabel(),   // host:port only, never userinfo
          opencodeAuthConfigured: Boolean(config.opencode.password),
          apiReachable: api.reachable,
          // Structured first so a caller can branch on `healthy` / `authRequired`;
          // the raw text is only a human-readable fallback.
          api,
          apiDetail: api.detail || api.error || null,
          capabilities: {
            submit: config.allowSubmit,
            cancel: config.allowCancel,
            transport: config.transport
          }
        };
        break;
      }
      case 'nexora_git_status':
        result = { ...(await nexoraGitStatus()), head: await nexoraHeadInfo() };
        break;
      case 'nexora_diff':
        result = await nexoraDiff(a);
        break;
      case 'nexora_log':
        result = await nexoraLog(a.limit ?? 20);
        break;
      case 'nexora_docs_index':
        result = await nexoraDocsIndex();
        break;
      case 'opencode_list_sessions':
        result = { sessions: await opencodeListSessions() };
        break;
      case 'opencode_task_status':
        // Reports a derived STATE, not just the tail of the transcript. A persisted user
        // message with no assistant reply is reported as 'persisted_not_run', never as done.
        result = await opencodeTaskOutcome(a.sessionId);
        break;
      case 'opencode_submit_task': {
        if (!config.allowSubmit) {
          throw new BridgeError('submit is disabled on this bridge (BRIDGE_ALLOW_SUBMIT=false)', 'forbidden');
        }
        result = await opencodeSubmitTask(a.task, { sessionId: a.sessionId });
        break;
      }
      case 'opencode_cancel_task':
        result = await opencodeCancelTask(a.sessionId);
        break;
      default:
        throw new BridgeError(`unknown tool: ${name}`, 'unknown_tool');
    }
    audit?.write({ tool: name, ok: true, ms: Date.now() - started });
    return {
      content: [{ type: 'text', text: redact(JSON.stringify(result, null, 2)).slice(0, config.limits.maxOutputBytes) }],
      isError: false
    };
  } catch (err) {
    const code = err instanceof BridgeError ? err.code : 'unexpected';
    audit?.write({ tool: name, ok: false, code, ms: Date.now() - started, error: err.message });
    return {
      content: [{ type: 'text', text: redact(`error[${code}]: ${err.message}`) }],
      isError: true
    };
  }
}

// ---------------------------------------------------------------- JSON-RPC

export function createServer({ audit } = {}) {
  return async function handle(message) {
    const { id, method, params } = message || {};
    const reply = (result) => ({ jsonrpc: '2.0', id: id ?? null, result });
    const fail = (code, message, data) => ({
      jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) }
    });

    switch (method) {
      case 'initialize': {
        // Lifecycle negotiation: echo the client's version when we implement it, otherwise
        // offer our newest supported revision and let the client decide (MCP lifecycle spec).
        const requested = params?.protocolVersion;
        const supported = config.mcp.supportedProtocolVersions;
        const chosen = supported.includes(requested) ? requested : supported[0];
        return reply({
          protocolVersion: chosen,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'nexora-opencode-bridge', version: '0.2.0' },
          instructions: INSTRUCTIONS
        });
      }
      case 'notifications/initialized':
        return null; // notification, no response
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call':
        return reply(await callTool(params?.name, params?.arguments || {}, { audit }));
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  };
}

// ---------------------------------------------------------------- stdio loop

export function startStdio({ input = process.stdin, output = process.stdout, audit } = {}) {
  const handle = createServer({ audit });
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
        continue;
      }
      Promise.resolve(handle(message))
        .then((res) => { if (res) output.write(JSON.stringify(res) + '\n'); })
        .catch((err) => {
          output.write(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: redact(String(err?.message || err)) } }) + '\n');
        });
    }
  });
  return handle;
}
