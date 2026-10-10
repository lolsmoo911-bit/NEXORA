/**
 * NEXORA — OpenCode bridge: configuration.
 *
 * Design rules (see docs/bridge-runbook.md):
 *  - No secret is ever stored in this repository. Every credential arrives through
 *    the environment or a file outside the workspace.
 *  - The bridge never executes a shell command on behalf of a caller. Git access is
 *    limited to a fixed, read-only argument allowlist.
 *  - The OpenCode API is reached over loopback by default. It is never re-exposed
 *    to the internet by this process.
 */

import path from 'node:path';

const env = process.env;

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function int(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  // ---- transport ----
  // stdio : speak MCP over stdin/stdout (how a local MCP client launches us)
  // http  : expose the same JSON-RPC surface on loopback for a tunnel in front of it
  transport: env.BRIDGE_TRANSPORT || 'stdio',

  // ---- OpenCode API (the agent we drive) ----
  opencode: {
    // Loopback by default. NEVER point this at a public address.
    baseUrl: env.OPENCODE_BASE_URL || 'http://127.0.0.1:4096',
    // Optional HTTP Basic password (OPENCODE_SERVER_PASSWORD). If set, it is sent as
    // the Basic auth user with the literal username "opencode" per opencode serve.
    password: env.OPENCODE_SERVER_PASSWORD || '',
    username: env.OPENCODE_USERNAME || 'opencode',
    requestTimeoutMs: int(env.OPENCODE_TIMEOUT_MS, 20000),
    // Optional explicit session to drive; otherwise the newest session is used.
    sessionId: env.OPENCODE_SESSION_ID || '',
    directory: env.OPENCODE_DIRECTORY || process.cwd()
  },

  // ---- our own auth (required for the http transport) ----
  // A reviewer connecting through a tunnel must present this. It is compared with a
  // timing-safe equality check. Leave empty only for stdio (a local, one-owner channel).
  bridgeToken: env.BRIDGE_TOKEN || '',

  // ---- workspace restrictions ----
  // The bridge will only ever look at, and operate on, this directory.
  workspaceRoot: path.resolve(env.NEXORA_WORKSPACE || process.cwd()),

  // ---- limits (anti-footgun, anti-leak) ----
  limits: {
    maxOutputBytes: int(env.BRIDGE_MAX_OUTPUT_BYTES, 20000),
    maxDiffBytes: int(env.BRIDGE_MAX_DIFF_BYTES, 60000),
    maxMessages: int(env.BRIDGE_MAX_MESSAGES, 50),
    // A submitted task text longer than this is rejected rather than truncated.
    maxTaskChars: int(env.BRIDGE_MAX_TASK_CHARS, 8000),
    // Hard ceiling for a single OpenCode request.
    maxRequestMs: int(env.BRIDGE_MAX_REQUEST_MS, 120000)
  },

  // ---- audit ----
  auditLogPath: env.BRIDGE_AUDIT_LOG || '',

  // ---- feature switches ----
  allowSubmit: bool(env.BRIDGE_ALLOW_SUBMIT, true),
  allowCancel: bool(env.BRIDGE_ALLOW_CANCEL, true),

  debug: bool(env.BRIDGE_DEBUG, false)
};

/** Hard validation performed once at startup. */
export function validateConfig(cfg = config) {
  const problems = [];
  if (cfg.transport !== 'stdio' && cfg.transport !== 'http') {
    problems.push(`unsupported BRIDGE_TRANSPORT: ${cfg.transport}`);
  }
  if (cfg.transport === 'http' && !cfg.bridgeToken) {
    problems.push('BRIDGE_TOKEN is required when BRIDGE_TRANSPORT=http');
  }
  if (cfg.limits.maxOutputBytes < 1024) problems.push('maxOutputBytes too small');
  if (cfg.limits.maxTaskChars < 100) problems.push('maxTaskChars too small');
  return { ok: problems.length === 0, problems };
}

/** Redact anything that looks like a credential before it can reach a log or a reply. */
export function redact(value, cfg = config) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const secrets = [];
  if (cfg.opencode.password) secrets.push(cfg.opencode.password);
  if (cfg.bridgeToken) secrets.push(cfg.bridgeToken);
  for (const secret of secrets) {
    if (!secret) continue;
    text = text.split(secret).join('***redacted***');
  }
  // Generic patterns, belt and braces.
  text = text
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '***redacted***')
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, '***redacted***')
    .replace(/0x[0-9a-fA-F]{64}\b/g, '0x***redacted-key***');
  return text;
}

export default config;
