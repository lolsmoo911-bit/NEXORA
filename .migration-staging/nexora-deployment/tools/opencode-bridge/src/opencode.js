import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';

const STATE_FILE = join(
  process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
  'opencode',
  'service.json',
);

let cachedService = null;

export class OpencodeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OpencodeError';
    this.status = status;
  }
}

async function resolveService() {
  if (cachedService && Date.now() - cachedService.readAt < 15_000) return cachedService;

  if (config.opencodeUrl) {
    cachedService = {
      url: config.opencodeUrl.replace(/\/$/, ''),
      password: config.opencodePassword || undefined,
      readAt: Date.now(),
    };
    return cachedService;
  }

  let raw;
  try {
    raw = JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch (error) {
    throw new OpencodeError(
      `Cannot find a running OpenCode service (${STATE_FILE}). Start OpenCode first, or set OPENCODE_URL and OPENCODE_PASSWORD.`,
      503,
    );
  }
  if (!raw?.url) throw new OpencodeError('OpenCode service registration has no URL', 503);

  cachedService = { url: String(raw.url).replace(/\/$/, ''), password: raw.password, readAt: Date.now() };
  return cachedService;
}

function authHeader(service) {
  if (!service.password) return {};
  const token = Buffer.from(`opencode:${service.password}`).toString('base64');
  return { authorization: `Basic ${token}` };
}

function buildUrl(service, path, query) {
  const url = new URL(path, service.url);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function request(path, options = {}) {
  const {
    method = 'GET',
    query,
    body,
    directory,
    timeout = 25_000,
    raw = false,
  } = options;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const service = await resolveService();
    const url = buildUrl(service, path, query);
    const headers = { ...authHeader(service) };
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      cachedService = null;
      throw new OpencodeError(`OpenCode request failed: ${error.name === 'TimeoutError' ? 'timed out' : error.message}`, 504);
    }

    if (response.status === 401 && attempt === 0) {
      cachedService = null;
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new OpencodeError(`OpenCode ${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`, response.status);
    }

    if (raw) {
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') || '',
      };
    }

    if (response.status === 204) return undefined;
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  throw new OpencodeError('OpenCode authentication failed', 401);
}

export function post(path, body, options = {}) {
  return request(path, { ...options, method: 'POST', body });
}

export function get(path, query, options = {}) {
  return request(path, { ...options, query });
}

export function remove(path, options = {}) {
  return request(path, { ...options, method: 'DELETE' });
}

const sessionPath = (id) => `/api/session/${encodeURIComponent(id)}`;

export async function listSessions({ search, limit = 10, directory } = {}) {
  const result = await get('/api/session', { search, limit, order: 'desc', directory });
  return result?.data ?? [];
}

export async function activeSessions() {
  const result = await get('/api/session/active');
  return result?.data ?? {};
}

export async function getSession(id) {
  const result = await get(sessionPath(id));
  return result?.data;
}

export async function createSession({ title, directory } = {}) {
  const result = await post('/api/session', { title }, { directory });
  return result?.data;
}

export async function getMessages(id, { limit = 40, order = 'desc', cursor } = {}) {
  const result = await get(`${sessionPath(id)}/message`, { limit, order: cursor ? undefined : order, cursor });
  return {
    messages: result?.data ?? [],
    cursor: result?.cursor ?? null,
  };
}

export async function sendPrompt(id, text, { directory } = {}) {
  const result = await post(`${sessionPath(id)}/prompt`, { text }, { directory, timeout: 30_000 });
  return result?.data;
}

export async function sessionDiff(id, { context } = {}) {
  const result = await get(`${sessionPath(id)}/diff`, { context });
  return result?.data ?? [];
}

export async function fsList({ path, directory } = {}) {
  const result = await get('/api/fs/list', { path, directory });
  return { entries: result?.data ?? [], location: result?.location };
}

export async function fsFind({ query, directory, limit = 30, type } = {}) {
  const result = await get('/api/fs/find', { query, directory, limit, type });
  return { entries: result?.data ?? [], location: result?.location };
}

function encodeFsPath(path) {
  return String(path)
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export async function fsRead({ path, directory } = {}) {
  const encoded = encodeFsPath(path);
  const result = await request(`/api/fs/read/${encoded}`, { directory, raw: true, timeout: 30_000 });
  return result;
}

export async function serviceInfo() {
  return get('/api/info', undefined, { timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Shell API (gated separately by the bridge config)
// ---------------------------------------------------------------------------

export async function shellCreate({ command, cwd, timeout, metadata } = {}) {
  if (!command || typeof command !== 'string') throw new OpencodeError('shell command is required');
  const body = { command };
  if (cwd) body.cwd = cwd;
  if (timeout) body.timeout = Math.max(0, Math.round(timeout));
  if (metadata) body.metadata = metadata;
  const result = await post('/api/shell', body, { timeout: 30_000 });
  return result?.data;
}

export async function shellGet(id) {
  const result = await get(`/api/shell/${encodeURIComponent(id)}`);
  return result?.data;
}

export async function shellList() {
  const result = await get('/api/shell');
  return result?.data ?? [];
}

export async function shellOutput(id, { cursor, limit } = {}) {
  const result = await get(`/api/shell/${encodeURIComponent(id)}/output`, { cursor, limit });
  return result?.data ?? {};
}

/** Poll a shell until it is no longer running. Returns the final Shell.Info. */
export async function waitForShell(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let info = null;
  while (Date.now() < deadline) {
    info = await shellGet(id).catch(() => null);
    if (!info) return null;
    if (info.status !== 'running') return info;
    await sleep(600);
  }
  return info ?? (await shellGet(id).catch(() => null));
}

// ---------------------------------------------------------------------------
// Filesystem write (POST /api/experimental/fs/write, query path, octet-stream body)
// ---------------------------------------------------------------------------

export async function fsWrite(path, content, { directory } = {}) {
  const service = await resolveService();
  const url = buildUrl(service, '/api/experimental/fs/write', { path, directory: typeof directory === 'string' && directory ? directory : undefined });
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader(service), 'content-type': 'application/octet-stream' },
    body: content ?? '',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new OpencodeError(`OpenCode fs write failed (${response.status}): ${text.slice(0, 400)}`, response.status);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true };
  }
}

export async function interrupt(id) {
  // POST /api/session/{sessionID}/interrupt → { interrupted: boolean }
  const result = await request(`${sessionPath(id)}/interrupt`, { method: 'POST', timeout: 15_000 });
  return result;
}

/**
 * Count the activity that happened since a timestamp: tool calls, new messages,
 * and the latest tool name. Used for honest progress reporting.
 */
export async function progressSince(id, afterMs) {
  let messages;
  try {
    ({ messages } = await getMessages(id, { limit: 20, order: 'desc' }));
  } catch {
    return { toolCalls: 0, tools: [], lastCompletedTool: null, userMessages: 0 };
  }
  const tools = [];
  let users = 0;
  let completed = null;
  for (const message of messages) {
    const created = message.time?.created || 0;
    if (created < afterMs - 500) continue;
    if (message.type === 'user') users += 1;
    if (message.type !== 'assistant') continue;
    for (const part of message.content || []) {
      if (part.type === 'tool') {
        tools.push(part.name);
        if (part.state?.status === 'completed') completed = part.name;
      }
    }
  }
  return { toolCalls: tools.length, tools: [...new Set(tools)], lastCompletedTool: completed, userMessages: users };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForAssistant(id, afterMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { messages } = await getMessages(id, { limit: 8, order: 'desc' });
    const found = messages.find(
      (message) => message.type === 'assistant' && message.time?.created >= afterMs && message.time?.completed,
    );
    if (found) return found;
    await sleep(700);
  }
  return null;
}

/**
 * Subscribe to the OpenCode event stream. Returns parsed event objects.
 */
export async function* eventStream(signal) {
  const service = await resolveService();
  const response = await fetch(new URL('/api/event', service.url), {
    headers: { ...authHeader(service), accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok) {
    throw new OpencodeError(`OpenCode event stream failed (${response.status})`, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const payload = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!payload) continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // ignore malformed frames
      }
    }
  }
}
