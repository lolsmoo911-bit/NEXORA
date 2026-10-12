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
export async function opencodeRequest(pathname, { method = 'GET', body, timeoutMs, capMs } = {}, cfg = config) {
  const url = `${cfg.opencode.baseUrl.replace(/\/+$/, '')}${pathname}`;
  const ceiling = Math.max(cfg.limits.maxRequestMs, capMs || 0);
  const budget = Math.min(timeoutMs || cfg.opencode.requestTimeoutMs, ceiling);

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
  if (text.trim() === '') return null;      // 204 No Content is a documented, valid answer
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

/** Create a session. Used by the real-server probe so it never touches a real session. */
export async function opencodeCreateSession(title, cfg = config) {
  const data = await opencodeRequest('/session', {
    method: 'POST',
    body: title ? { title } : {}
  }, cfg);
  if (!data?.id) throw new BridgeError('OpenCode did not return a session id', 'no_session');
  return { id: data.id, title: data.title ?? null };
}

/** Delete a session and all of its data. Used only to clean up the probe session. */
export async function opencodeDeleteSession(sessionId, cfg = config) {
  const ok = await opencodeRequest(`/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, cfg);
  return { sessionId, deleted: ok !== false };
}

/** Documented: GET /session/status -> { [sessionID]: SessionStatus }. */
export async function opencodeSessionStatus(cfg = config) {
  const data = await opencodeRequest('/session/status', {}, cfg);
  if (!data || typeof data !== 'object') return {};
  return data;
}

/** New task correlation id. We supply messageID so a reply can be tied to OUR task. */
function newMessageId() {
  return 'msg_' + (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`).replace(/-/g, '');
}

function textOf(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .filter((p) => p?.type === 'text' && typeof p?.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/**
 * Submit a bounded task and PROVE the model ran.
 *
 * Mechanism (chosen deliberately, see docs/bridge-runbook.md):
 *   POST /session/:id/message  WITHOUT `noReply` — the OpenCode server documents this as
 *   "Send a message and wait for response", so the response body is the assistant message.
 *   `noReply: true` is deliberately NOT sent: it persists the user message and returns
 *   without running the model, which would make this function report a success that never
 *   happened.
 *
 * A success is reported only when all of the following hold:
 *   1. the HTTP call succeeded,
 *   2. the returned `info.role` is 'assistant' (not 'user'),
 *   3. the assistant message carries at least one non-empty text part,
 *   4. a follow-up read of the session shows that assistant message, correlated to the
 *      task message id we supplied.
 * Any of these failing raises a BridgeError. There is no path that reports success on a
 * persisted user message alone.
 */
export async function opencodeSubmitTask(taskText, { sessionId } = {}, cfg = config) {
  const text = String(taskText ?? '').trim();
  if (!text) throw new BridgeError('task text is empty', 'invalid_input');
  if (text.length > cfg.limits.maxTaskChars) {
    throw new BridgeError(`task text exceeds ${cfg.limits.maxTaskChars} characters`, 'invalid_input');
  }

  const target = sessionId || (await opencodeResolveSession(cfg));
  const messageId = newMessageId();
  const waitMs = cfg.limits.maxModelWaitMs;
  const startedAt = Date.now();

  const result = await opencodeRequest(`/session/${encodeURIComponent(target)}/message`, {
    method: 'POST',
    timeoutMs: waitMs,
    capMs: waitMs,
    body: {
      messageID: messageId,
      parts: [{ type: 'text', text }]
      // no `noReply` on purpose - see the note above.
    }
  }, cfg);

  const info = result?.info ?? null;
  const reply = result ? textOf(result) : '';

  // Gate 1-3: the server must have come back with an actual assistant message.
  if (!info || info.role !== 'assistant') {
    throw new BridgeError(
      `OpenCode persisted the task but returned no assistant message (role=${info?.role ?? 'none'}). ` +
      'The model did not run, so this is reported as a failure, not a success.',
      'no_assistant_reply'
    );
  }
  if (!reply) {
    throw new BridgeError(
      `OpenCode returned assistant message ${info.id} with no text content. ` +
      'The model produced no answer, so this is reported as a failure, not a success.',
      'no_assistant_reply'
    );
  }

  // Gate 4: the reply must be in the session AND parented to the task message id we supplied.
  //
  // There is deliberately NO "some other assistant message will do" fallback here. An earlier
  // version ended this gate with `|| history.messages.find(m => m.role === 'assistant')`,
  // which accepted ANY assistant message in the room — a reply to a previous task, a reply to
  // somebody else's turn — and then returned it alongside `taskMessageId: messageId` as though
  // the two had been proven related. The gate existed to establish correlation and instead
  // discarded it.
  //
  // If the server will not link the reply to our message, the correct outcome is a reported
  // failure. An unverifiable answer is not a successful task.
  const history = await opencodeGetMessages(target, cfg);
  const confirmed = history.messages.find((m) => m.id === info.id);
  if (!confirmed) {
    throw new BridgeError(
      `assistant message ${info.id} was not found when re-reading the session; ` +
      'the reply could not be confirmed, so this is reported as a failure.',
      'reply_unconfirmed'
    );
  }
  if (confirmed.parentId !== messageId) {
    throw new BridgeError(
      `assistant message ${info.id} is parented to ${confirmed.parentId ?? 'nothing'}, not to the ` +
      `task message ${messageId}. An unrelated reply cannot stand in for this task, so this is ` +
      'reported as a failure.',
      'reply_unrelated'
    );
  }

  return {
    sessionId: target,
    modelRan: true,
    taskMessageId: messageId,
    assistantMessageId: info.id,
    assistantText: redact(reply).slice(0, cfg.limits.maxOutputBytes),
    elapsedMs: Date.now() - startedAt,
    maxWaitMs: waitMs
  };
}

/** Read the tail of a session's messages. */
export async function opencodeGetMessages(sessionId, cfg = config) {
  const target = sessionId || (await opencodeResolveSession(cfg));
  const data = await opencodeRequest(`/session/${encodeURIComponent(target)}/message`, {}, cfg);
  const list = Array.isArray(data) ? data : (data?.data ?? []);
  const tail = list.slice(-cfg.limits.maxMessages).map((m) => ({
    role: m?.info?.role ?? null,
    id: m?.info?.id ?? null,
    parentId: m?.info?.parentID ?? m?.info?.parentId ?? null,
    created: m?.info?.time?.created ?? null,
    text: redact(textOf(m)).slice(0, 4000)
  }));
  return { sessionId: target, messages: tail, total: list.length };
}

/**
 * Report the state of the MOST RECENT task, not just the last messages.
 *
 * A persisted user message is NOT evidence that the model ran. The state is derived from
 * the server's own signals, in this order:
 *   - an assistant message whose parentID is the last user message  -> 'completed'
 *   - GET /session/status says the session is still busy             -> 'running'
 *   - a user message exists with no assistant reply and the session is idle
 *                                                                   -> 'persisted_not_run'
 *   - nothing to judge                                             -> 'unknown'
 * `persisted_not_run` is the state that the old implementation could not distinguish, and
 * it is the whole reason this function exists.
 */
export async function opencodeTaskOutcome(sessionId, cfg = config) {
  const target = sessionId || (await opencodeResolveSession(cfg));
  const history = await opencodeGetMessages(target, cfg);
  let statuses = {};
  try { statuses = await opencodeSessionStatus(cfg); } catch { /* status is optional */ }
  const sessionStatus = statuses?.[target] ?? null;

  const messages = history.messages;
  let lastUser = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUser = messages[i]; break; }
  }
  if (!lastUser) {
    return { sessionId: target, state: 'unknown', sessionStatus, taskMessageId: null, assistantMessageId: null, assistantText: null, messages };
  }
  // Correlation requires parentID === the task message id. The previous fallback accepted any
  // assistant message merely NEWER than the task message, which is the definition of an
  // unrelated reply: anything that arrived after our task satisfies "created >=".
  const reply = messages.find((m) => m.role === 'assistant' && m.parentId === lastUser.id);

  const busy = Boolean(sessionStatus && (sessionStatus.state === 'busy' || sessionStatus.status === 'busy' || sessionStatus.busy === true));
  if (reply && reply.text) {
    return { sessionId: target, state: 'completed', sessionStatus, taskMessageId: lastUser.id, assistantMessageId: reply.id, assistantText: reply.text, messages };
  }
  if (busy) {
    return { sessionId: target, state: 'running', sessionStatus, taskMessageId: lastUser.id, assistantMessageId: null, assistantText: null, messages };
  }
  return {
    sessionId: target,
    state: 'persisted_not_run',
    sessionStatus,
    taskMessageId: lastUser.id,
    assistantMessageId: null,
    assistantText: null,
    note: 'The task text is stored on the server but no assistant reply is associated with it. Do not treat this as a completed task.',
    messages
  };
}

/** Cancel a running session task. Guarded by cfg.allowCancel. */
export async function opencodeCancelTask(sessionId, cfg = config) {
  if (!cfg.allowCancel) throw new BridgeError('cancel is disabled on this bridge (BRIDGE_ALLOW_CANCEL=false)', 'forbidden');
  const target = sessionId || (await opencodeResolveSession(cfg));
  const result = await opencodeRequest(`/session/${encodeURIComponent(target)}/abort`, { method: 'POST', body: {} }, cfg);
  return { sessionId: target, result: redact(JSON.stringify(result ?? {})) };
}
