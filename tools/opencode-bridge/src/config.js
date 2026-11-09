import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function number(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function rootList(value) {
  return String(value || '')
    .split(/[;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry === '~' ? homedir() : entry.startsWith('~/') ? join(homedir(), entry.slice(2)) : entry));
}

/** Parse BRIDGE_WORKSPACE_ROOTS the same way at config time and on every call. */
export function parseRootList() {
  return rootList(process.env.BRIDGE_WORKSPACE_ROOTS);
}

function endpointPath(value) {
  let path = String(value || '/mcp').trim();
  if (!path.startsWith('/')) path = '/' + path;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

export const config = {
  host: process.env.BRIDGE_HOST || '127.0.0.1',
  port: number('BRIDGE_PORT', 8787),
  path: endpointPath(process.env.BRIDGE_PATH),
  token: process.env.BRIDGE_TOKEN || '',
  allowWrite: process.env.BRIDGE_ALLOW_WRITE === '1',
  directory: process.env.BRIDGE_DIRECTORY || '',
  maxOutput: number('BRIDGE_MAX_TOOL_OUTPUT', 4000),
  eventBuffer: number('BRIDGE_EVENT_BUFFER', 400),
  opencodeUrl: process.env.OPENCODE_URL || '',
  opencodePassword: process.env.OPENCODE_PASSWORD || '',

  // Capability flags: every remote capability is opt-in and scope-gated.
  allowShell: process.env.BRIDGE_ALLOW_SHELL === '1',
  allowScreenshot: process.env.BRIDGE_ALLOW_SCREENSHOT === '1',

  // Approved workspace roots for file operations (semicolon separated).
  // Writes are rejected when no root is configured; reads fall back to the home dir.
  workspaceRoots: rootList(process.env.BRIDGE_WORKSPACE_ROOTS),

  // Direct shell limits (when BRIDGE_ALLOW_SHELL=1).
  shellTimeout: number('BRIDGE_SHELL_TIMEOUT', 60),
  shellWait: number('BRIDGE_SHELL_WAIT', 90),

  // Hardening.
  maxRequestBytes: number('BRIDGE_MAX_REQUEST_BYTES', 4_000_000),
  rateLimitPerMinute: number('BRIDGE_RATE_LIMIT', 200),
  shellDangerousConfirm: process.env.BRIDGE_SHELL_CONFIRM !== '0',

  // Audit trail (JSONL, sanitized with src/audit.js).
  auditFile: process.env.BRIDGE_AUDIT_FILE || join(ROOT, '.audit', 'audit.jsonl'),

  // OAuth: enabled as soon as a local password is configured. ChatGPT picks up
  // the OAuth metadata automatically and shows a browser login page once.
  oauthPassword: process.env.BRIDGE_OAUTH_PASSWORD || '',
  oauthClientId: process.env.BRIDGE_OAUTH_CLIENT_ID || 'opencode-chatgpt',
  oauthTokensFile: process.env.BRIDGE_OAUTH_TOKENS_FILE || join(ROOT, '.auth', 'tokens.json'),
  publicUrl: (process.env.BRIDGE_PUBLIC_URL || '').trim(),
  oauthIssuer: (requestUrl) => {
    const url = new URL(requestUrl, 'http://localhost');
    return `${url.protocol}//${url.host}`;
  },
};

export const SCOPES = {
  read: 'mcp:read',
  write: 'mcp:write',
  shell: 'bridge:shell',
  screenshot: 'bridge:screenshot',
};

export const CAPABILITIES = [
  {
    scope: SCOPES.write,
    flag: 'allowWrite',
    label: 'Let this app send instructions to the OpenCode agent (it can run commands and edit files)',
  },
  {
    scope: SCOPES.shell,
    flag: 'allowShell',
    label: 'Let this app run terminal commands through the bridge shell API',
  },
  {
    scope: SCOPES.screenshot,
    flag: 'allowScreenshot',
    label: 'Let this app capture a screenshot of the primary screen',
  },
];

export function allScopes() {
  const scopes = [SCOPES.read];
  for (const capability of CAPABILITIES) {
    if (config[capability.flag]) scopes.push(capability.scope);
  }
  return scopes;
}

export function enabledCapabilities() {
  return CAPABILITIES.filter((capability) => config[capability.flag]);
}


