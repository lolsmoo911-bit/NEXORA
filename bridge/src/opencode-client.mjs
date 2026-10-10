/**
 * NEXORA — OpenCode API client.
 *
 * Talks to the OpenCode HTTP API described in https://docs.opencode.ai/docs/server/
 * Every request is: loopback by default, optionally HTTP Basic authenticated,
 * time-bounded, and response-bounded. No method here can run a shell command.
 */

import { config, redact } from './config.mjs';

export class BridgeError extends Error {
  constructor(message, code = 'bridge_error', details = undefined) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

function basicAuthHeader(username, password) {
  const raw = `${username}:${password}`;
  const encoded = Buffer.from(raw, 'utf8').toString('base64');
  return `Basic ${encoded}`;
}

/** Perform one bounded OpenCode API call. */
export async function opencodeRequest(pathname, { method = 'GET', body, timeoutMs } = {}, cfg = config) {
  const url = `${cfg.opencode.baseUrl.replace(/\/+$/, '')}${pathname}`;
  const budget = Math.min(timeoutMs || cfg.opencode.requestTimeoutMs, cfg.limits.maxRequestMs);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  const headers = { Accept: 'application/json', 'User-Agent': 'nexora-opencode-bridge/0.1' };
  if (cfg.opencode.password) {
    headers.Authorization = basicAuthHeader(cfg.opencode.username, cfg.opencode.password);
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      throw new BridgeError(`opencode request timed out after ${budget}ms: ${method} ${pathname}`, 'upstream_timeout');
    }
    throw new BridgeError(`cannot reach the OpenCode API at ${cfg.opencode.baseUrl}: ${err?.message || err}`, 'upstream_unreachable');
  }
  clearTimeout(timer);

  const text = await response.text();
  if (!response.ok) {
    throw new BridgeError(
      `opencode API returned ${response.status} for ${method} ${pathname}: ${redact(text).slice(0, 500)}`,
      'upstream_status',
      { status: response.status }
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Health probe. Distinguishes "API is up" from "API needs auth" from "no API".
 *  Documented shape: GET /global/health -> { healthy: true, version: string }. */
export async function opencodeHealth(cfg = config) {
  try {
    const data = await opencodeRequest('/global/health', { timeoutMs: 5000 }, cfg);
    const healthy = data?.healthy ?? data?.status ?? null;
    return { reachable: true, healthy, version: data?.version ?? null, detail: redact(JSON.stringify(data)) };
  } catch (err) {
    if (err instanceof BridgeError && err.code === 'upstream_status' && err.details?.status === 401) {
      return { reachable: true, authRequired: true, detail: 'OpenCode API answered 401: a password is required (OPENCODE_SERVER_PASSWORD).' };
    }
    return { reachable: false, error: err.message };
  }
}

/** Sessions exposed by the OpenCode server. */
export async function opencodeListSessions(cfg = config) {
  const data = await opencodeRequest('/session', {}, cfg);
  const sessions = Array.isArray(data) ? data : (data?.data ?? []);
  return sessions.slice(0, cfg.limits.maxMessages).map((s) => ({
    id: s?.id,
    title: s?.title ?? null,
    updated: s?.updated ?? s?.time?.updated ?? null,
    directory: s?.directory ?? null
  }));
}

/** Resolve which session to act on: explicit id, else the most recently updated one. */
export async function opencodeResolveSession(cfg = config) {
  if (cfg.opencode.sessionId) return cfg.opencode.sessionId;
  const sessions = await opencodeListSessions(cfg);
  if (!sessions.length) throw new BridgeError('the OpenCode server has no sessions to act on', 'no_session');
  const sorted = [...sessions].sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')));
  return sorted[0].id;
}

/** Submit a bounded task as a new chat message on a session. This is the WRITE action.
 *  Documented: POST /session/:id/message  body { messageID?, model?, agent?, noReply?, parts } -> { info, parts }.
 *  We use noReply:true so the bridge does not block waiting for the full agent response; the
 *  reviewer polls opencode_task_status instead. This matches the documented noReply flag. */
export async function opencodeSubmitTask(taskText, { sessionId } = {}, cfg = config) {
  const text = String(taskText ?? '').trim();
  if (!text) throw new BridgeError('task text is empty', 'invalid_input');
  if (text.length > cfg.limits.maxTaskChars) {
    throw new BridgeError(`task text exceeds ${cfg.limits.maxTaskChars} characters`, 'invalid_input');
  }
  const target = sessionId || (await opencodeResolveSession(cfg));
  const result = await opencodeRequest(`/session/${encodeURIComponent(target)}/message`, {
    method: 'POST',
    body: {
      noReply: true,
      parts: [{ type: 'text', text }]
    }
  }, cfg);
  return { sessionId: target, result: redact(JSON.stringify(result ?? {})).slice(0, cfg.limits.maxOutputBytes) };
}

/** Read the tail of a session's messages. */
export async function opencodeGetMessages(sessionId, cfg = config) {
  const target = sessionId || (await opencodeResolveSession(cfg));
  const data = await opencodeRequest(`/session/${encodeURIComponent(target)}/message`, {}, cfg);
  const list = Array.isArray(data) ? data : (data?.data ?? []);
  const tail = list.slice(-cfg.limits.maxMessages).map((m) => {
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    const text = parts
      .filter((p) => p?.type === 'text' && typeof p?.text === 'string')
      .map((p) => p.text)
      .join('\n');
    return {
      role: m?.info?.role ?? null,
      id: m?.info?.id ?? null,
      created: m?.info?.time?.created ?? null,
      text: redact(text).slice(0, 4000)
    };
  });
  return { sessionId: target, messages: tail };
}

/** Cancel a running session task. Guarded by cfg.allowCancel. */
export async function opencodeCancelTask(sessionId, cfg = config) {
  if (!cfg.allowCancel) throw new BridgeError('cancel is disabled on this bridge (BRIDGE_ALLOW_CANCEL=false)', 'forbidden');
  const target = sessionId || (await opencodeResolveSession(cfg));
  const result = await opencodeRequest(`/session/${encodeURIComponent(target)}/abort`, { method: 'POST', body: {} }, cfg);
  return { sessionId: target, result: redact(JSON.stringify(result ?? {})) };
}
