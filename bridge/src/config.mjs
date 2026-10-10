/**
 * NEXORA — OpenCode bridge: configuration.
 *
 * Hardening rules (owner review, 2026-10-10):
 *  - No secret is stored in this repository; credentials come from the environment.
 *  - The bridge never executes a shell command on a caller's behalf.
 *  - The OpenCode API is loopback-only unless an explicit, reviewed opt-in is set.
 *  - Every limit is positive and upper-bounded.
 *  - Credentials and URL userinfo are never logged or returned.
 */

import path from 'node:path';

const env = process.env;

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

/** Parse an integer and clamp it into [min, max]. Out-of-range input is an error. */
function boundedInt(name, raw, { min, max, fallback }) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer (got ${raw})`);
  if (n < min || n > max) throw new Error(`${name} must be within [${min}, ${max}] (got ${n})`);
  return n;
}

/** True for loopback literals only. */
export function isLoopbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** True if the URL carries userinfo (user:pass@host), which we refuse to log or accept. */
export function hasUserInfo(value) {
  try { return Boolean(new URL(value).username || new URL(value).password); } catch { return false; }
}

export function buildConfig(source = env) {
  const transport = source.BRIDGE_TRANSPORT || 'stdio';
  const baseUrl = source.OPENCODE_BASE_URL || 'http://127.0.0.1:4096';
  // Refuse a non-loopback OpenCode URL unless the owner explicitly reviewed and enabled it.
  const allowRemoteOpencode = bool(source.BRIDGE_ALLOW_REMOTE_OPENCODE, false);

  return {
    transport,

    opencode: {
      baseUrl,
      password: source.OPENCODE_SERVER_PASSWORD || '',
      username: source.OPENCODE_USERNAME || 'opencode',
      requestTimeoutMs: boundedInt('OPENCODE_TIMEOUT_MS', source.OPENCODE_TIMEOUT_MS, { min: 1000, max: 600000, fallback: 20000 }),
      sessionId: source.OPENCODE_SESSION_ID || '',
      directory: source.OPENCODE_DIRECTORY || process.cwd()
    },

    bridgeToken: source.BRIDGE_TOKEN || '',
    workspaceRoot: path.resolve(source.NEXORA_WORKSPACE || process.cwd()),

    limits: {
      maxOutputBytes: boundedInt('BRIDGE_MAX_OUTPUT_BYTES', source.BRIDGE_MAX_OUTPUT_BYTES, { min: 1024, max: 2000000, fallback: 20000 }),
      maxDiffBytes: boundedInt('BRIDGE_MAX_DIFF_BYTES', source.BRIDGE_MAX_DIFF_BYTES, { min: 1024, max: 5000000, fallback: 60000 }),
      maxMessages: boundedInt('BRIDGE_MAX_MESSAGES', source.BRIDGE_MAX_MESSAGES, { min: 1, max: 500, fallback: 50 }),
      maxTaskChars: boundedInt('BRIDGE_MAX_TASK_CHARS', source.BRIDGE_MAX_TASK_CHARS, { min: 100, max: 100000, fallback: 8000 }),
      maxRequestMs: boundedInt('BRIDGE_MAX_REQUEST_MS', source.BRIDGE_MAX_REQUEST_MS, { min: 1000, max: 900000, fallback: 120000 }),
      // Max accepted HTTP body for an MCP POST.
      maxHttpBodyBytes: boundedInt('BRIDGE_MAX_HTTP_BODY', source.BRIDGE_MAX_HTTP_BODY, { min: 1024, max: 5000000, fallback: 262144 })
    },

    // MCP protocol revisions this server implements. See
    // https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http
    mcp: {
      // Advertised and accepted. The 2026-07-28 revision removed GET streams and
      // protocol-level sessions, which this server does not implement.
      supportedProtocolVersions: (source.BRIDGE_MCP_VERSIONS || '2026-07-28,2025-11-25,2025-06-18,2025-03-26').split(',').map((s) => s.trim()).filter(Boolean),
      // The single MCP endpoint path.
      endpointPath: source.BRIDGE_MCP_PATH || '/mcp',
      // Origin validation. Empty means "allow only requests without an Origin header"
      // (typical for a server-to-server tunnel, which sends none).
      allowedOrigins: (source.BRIDGE_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
      // Allow a non-loopback bind. Off by default: this process must not be published.
      allowNonLoopbackBind: bool(source.BRIDGE_ALLOW_NON_LOOPBACK_BIND, false),
      // Require MCP-Protocol-Version on every POST.
      requireProtocolHeader: bool(source.BRIDGE_REQUIRE_PROTOCOL_HEADER, true)
    },

    auditLogPath: source.BRIDGE_AUDIT_LOG || '',
    allowSubmit: bool(source.BRIDGE_ALLOW_SUBMIT, true),
    allowCancel: bool(source.BRIDGE_ALLOW_CANCEL, true),
    allowRemoteOpencode,
    debug: bool(source.BRIDGE_DEBUG, false)
  };
}

export const config = buildConfig(env);

/** Validation performed at startup and by `index.mjs --check`.
 *  Every field is treated as optional so this can validate partial configs in tests. */
export function validateConfig(cfg = config) {
  const problems = [];
  const transport = cfg?.transport ?? 'stdio';
  if (transport !== 'stdio' && transport !== 'http') {
    problems.push(`unsupported BRIDGE_TRANSPORT: ${transport}`);
  }
  if (transport === 'http' && !cfg?.bridgeToken) {
    problems.push('BRIDGE_TOKEN is required when BRIDGE_TRANSPORT=http');
  }
  const baseUrl = cfg?.opencode?.baseUrl;
  if (baseUrl !== undefined && baseUrl !== null && baseUrl !== '') {
    if (hasUserInfo(baseUrl)) {
      problems.push('OPENCODE_BASE_URL must not contain userinfo (user:password@host)');
    } else if (!cfg?.allowRemoteOpencode && !isLoopbackUrl(baseUrl)) {
      problems.push(`OPENCODE_BASE_URL must be loopback (got a non-loopback host). Set BRIDGE_ALLOW_REMOTE_OPENCODE=1 only after an explicit review.`);
    }
  }
  for (const [key, value] of Object.entries(cfg?.limits ?? {})) {
    if (!Number.isFinite(value) || value <= 0) problems.push(`limit ${key} must be positive`);
  }
  const versions = cfg?.mcp?.supportedProtocolVersions;
  if (versions !== undefined && (!Array.isArray(versions) || versions.length === 0)) {
    problems.push('no MCP protocol versions advertised');
  }
  const endpointPath = cfg?.mcp?.endpointPath;
  if (endpointPath !== undefined && typeof endpointPath === 'string' && !endpointPath.startsWith('/')) {
    problems.push('BRIDGE_MCP_PATH must start with /');
  }
  return { ok: problems.length === 0, problems };
}

/** Strip anything credential-shaped from text before it is logged or returned. */
export function redact(value, cfg = config) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const secrets = [];
  if (cfg.opencode?.password) secrets.push(cfg.opencode.password);
  if (cfg.bridgeToken) secrets.push(cfg.bridgeToken);
  for (const secret of secrets) {
    if (!secret) continue;
    text = text.split(secret).join('***redacted***');
  }
  text = text
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '***redacted***')
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, '***redacted***')
    .replace(/0x[0-9a-fA-F]{64}\b/g, '0x***redacted-key***');
  // never echo URL userinfo
  text = text.replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//***redacted***@');
  return text;
}

/** A log-safe description of where the agent lives (no credentials, no userinfo). */
export function safeEndpointLabel(cfg = config) {
  try {
    const u = new URL(cfg.opencode.baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'invalid-url';
  }
}

export default config;
