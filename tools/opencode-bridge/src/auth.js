import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SCOPES, allScopes, config, enabledCapabilities } from './config.js';

const ACCESS_TTL = 60 * 60; // seconds
const REFRESH_TTL = 30 * 24 * 60 * 60;
const CODE_TTL = 120;

const accessTokens = new Map();
const refreshTokens = new Map();
const codes = new Map();
/** Dynamic OAuth clients (RFC 7591). Key: client_id, value: {client_name, redirectUris, issuedAt} */
const clients = new Map();

let loaded = false;
let saveQueued = false;

export function oauthEnabled() {
  return Boolean(config.oauthPassword);
}

function readClientsFile() {
  return join(config.oauthTokensFile, '..', 'clients.json');
}

function persistClients() {
  try {
    mkdirSync(dirname(config.oauthTokensFile), { recursive: true });
    const data = {};
    for (const [clientId, entry] of clients) data[clientId] = entry;
    writeFileSync(readClientsFile(), JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[auth] cannot persist clients:', error.message);
  }
}

function loadClients() {
  try {
    const raw = JSON.parse(readFileSync(readClientsFile(), 'utf8'));
    for (const [clientId, entry] of Object.entries(raw || {})) clients.set(clientId, entry);
  } catch {
    // no dynamic clients yet
  }
}

export function isKnownClient(clientId) {
  loadClients();
  if (!clientId) return false;
  return clientId === config.oauthClientId || clients.has(clientId);
}

function clientRedirectUris(clientId) {
  if (clientId === config.oauthClientId) return null; // any https origin
  return clients.get(clientId)?.redirectUris ?? null;
}

function validRedirect(clientId, redirectUri) {
  let url;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.origin === 'null') return false;
  const allowed = clientRedirectUris(clientId);
  if (allowed === null) return true;
  return allowed.some((candidate) => candidate.replace(/\/$/, '') === redirectUri.replace(/\/$/, ''));
}

function ensureTokensFile() {
  mkdirSync(dirname(config.oauthTokensFile), { recursive: true });
}

function persist() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    try {
      ensureTokensFile();
      const data = {};
      for (const [token, entry] of refreshTokens) {
        if (entry.exp > Math.floor(Date.now() / 1000)) data[token] = entry;
      }
      writeFileSync(config.oauthTokensFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('[auth] cannot persist tokens:', error.message);
    }
  }, 200);
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(readFileSync(config.oauthTokensFile, 'utf8'));
    const now = Math.floor(Date.now() / 1000);
    for (const [token, entry] of Object.entries(raw || {})) {
      if (entry && entry.exp > now) refreshTokens.set(token, entry);
    }
  } catch {
    // first run or unreadable file: start empty
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function s256(verifier) {
  return createHash('sha256').update(String(verifier)).digest('base64url');
}

function issueTokens({ clientId, scopes, resource }) {
  load();
  const now = Math.floor(Date.now() / 1000);
  const accessToken = randomBytes(32).toString('base64url');
  const refreshToken = randomBytes(32).toString('base64url');
  accessTokens.set(accessToken, { clientId, scopes, resource, exp: now + ACCESS_TTL });
  refreshTokens.set(refreshToken, { clientId, scopes, resource, exp: now + REFRESH_TTL, issuedAt: now });
  ipcCleanup();
  persist();
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: refreshToken,
    scope: scopes.join(' '),
  };
}

function ipcCleanup() {
  const now = Math.floor(Date.now() / 1000);
  for (const [token, entry] of accessTokens) {
    if (entry.exp <= now) accessTokens.delete(token);
  }
  for (const [code, entry] of codes) {
    if (entry.exp <= now) codes.delete(code);
  }
}

/**
 * Validate an Authorization header. Returns null when invalid.
 */
export function authenticateRequest(req, fallback) {
  load();
  ipcCleanup();
  if (fallback) return fallback;
  if (!oauthEnabled()) {
    if (!config.token) return { clientId: 'anonymous', scopes: allScopes() };
    // OAuth disabled but a static bridge token is configured.
    const header = req.headers.authorization || '';
    if (header !== `Bearer ${config.token}`) return null;
    return { clientId: 'static', scopes: allScopes() };
  }
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const entry = accessTokens.get(match[1]);
  if (!entry) return null;
  return { clientId: entry.clientId, scopes: entry.scopes, resource: entry.resource };
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function rawJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readForm(req) {
  return readBody(req).then((text) => new URLSearchParams(text));
}

function page(title, body) {
  return `<!doctype html>
<html lang="ar"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Tahoma,sans-serif;background:#0b1021;color:#e7ebf5;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
  .card{background:#131a33;border:1px solid #28325a;border-radius:14px;max-width:520px;padding:28px;
        box-shadow:0 12px 40px rgba(0,0,0,.45)}
  h1{font-size:1.1rem;margin:0 0 6px}
  p{color:#a8b3cf;font-size:.92rem;line-height:1.5;margin:6px 0}
  code{background:#0b1021;padding:2px 6px;border-radius:6px;font-size:.82rem}
  input[type=password]{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #33406e;
       background:#0b1021;color:#e7ebf5;font-size:1rem}
  label{display:block;margin:14px 0 6px;font-size:.9rem;color:#c7d0e8}
  button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:10px;background:#5a7dfe;color:#fff;
         font-size:1rem;cursor:pointer}
  .warn{background:#3a2230;border:1px solid #6d3a4a;border-radius:10px;padding:10px;color:#f2c0c8;font-size:.85rem}
</style></head><body><form method="post" action="/authorize/complete">
<div class="card">${body}</div></form></body></html>`;
}

function authorizePage(issuer, query) {
  const redirect = new URL(query.get('redirect_uri'));
  const capabilities = enabledCapabilities();
  const hidden = [...query]
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${value.replace(/"/g, '&quot;')}">`)
    .join('\n');
  const checkboxes = capabilities
    .map(
      (capability) =>
        `<label style="margin:10px 0"><input type="checkbox" name="grant" value="${capability.scope}"> <code>${capability.scope}</code> — ${capability.label}</label>`,
    )
    .join('\n');
  const canExtras = capabilities.length > 0;
  return page('OpenCode bridge', `
    <h1>Authorize ${query.get('client_id')}</h1>
    <p>An app is asking for access to <strong>your OpenCode agent</strong> through the local bridge.</p>
    <p>Redirect to: <code>${redirect.host}</code> — Grant type: authorization code + PKCE (S256).</p>
    <p>Always granted: <code>mcp:read</code> (view sessions, files, diffs, events).</p>
    ${canExtras ? '<div class="warn"><strong>Optional powers.</strong> Check what this app may do. Unchecked = read-only.</div>' : '<p>All write helpers are disabled in the bridge configuration; this grant is read-only.</p>'}
    ${checkboxes}
    <label>Bridge password</label>
    <input type="password" name="password" placeholder="password from .env" required>
    ${hidden}
    <button type="submit">Continue</button>
    <p style="font-size:.8rem">Issuer: <code>${issuer}</code></p>
  `);
}

function validateAuthorizeQuery(query) {
  if (query.get('response_type') !== 'code') return 'response_type must be "code".';
  const clientId = query.get('client_id') || '';
  if (!isKnownClient(clientId)) {
    return `Unknown client_id "${clientId || '(empty)'}". Register at /register or use "${config.oauthClientId}".`;
  }
  if (query.get('code_challenge_method') !== 'S256') return 'code_challenge_method must be S256.';
  if (!query.get('code_challenge')) return 'A code_challenge (PKCE) is required.';
  if (!validRedirect(clientId, query.get('redirect_uri'))) {
    return 'redirect_uri is not registered for this client.';
  }
  return null;
}


/**
 * Handles all non-MCP OAuth routes. Returns true when the request is handled.
 */
export async function handleAuthRoutes(req, res, pathname, query, origin) {
  if (!oauthEnabled()) return false;

  if (pathname === '/.well-known/oauth-authorization-server' || pathname === '/.well-known/openid-configuration') {
    rawJson(res, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: allScopes(),
    });
    return true;
  }

  if (pathname === '/.well-known/oauth-protected-resource') {
    rawJson(res, 200, {
      resource: `${origin}${config.path}`,
      authorization_servers: [origin],
      scopes_supported: allScopes(),
      bearer_methods_supported: ['header'],
    });
    return true;
  }

  if (pathname === '/authorize' && req.method === 'GET') {
    const error = validateAuthorizeQuery(query);
    if (error) {
      console.log(`[oauth] authorize REJECTED ip=${req.socket?.remoteAddress || '?'} ua="${(req.headers['user-agent'] || '?').slice(0, 90)}" reason=${error}`);
      html(res, 400, page('OpenCode bridge', `<h1>Cannot authorize</h1><p>${error}</p>`));
      return true;
    }
    console.log(`[oauth] authorize page client=${query.get('client_id') || '?'} ip=${req.socket?.remoteAddress || '?'} ua="${(req.headers['user-agent'] || '?').slice(0, 90)}"`);
    html(res, 200, authorizePage(origin, query));
    return true;
  }

  if (pathname === '/register' && req.method === 'POST') {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      body = {};
    }
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((uri) => typeof uri === 'string' && /^https?:\/\//i.test(uri))
      : [];
    if (!redirectUris.length) {
      rawJson(res, 400, { error: 'invalid_client_metadata', error_description: 'redirect_uris must be an HTTPS array.' });
      return true;
    }
    const clientId = `cfg_${randomBytes(12).toString('hex')}`;
    const entry = {
      client_name: String(body.client_name || 'MCP client').slice(0, 80),
      redirectUris,
      issuedAt: Math.floor(Date.now() / 1000),
    };
    clients.set(clientId, entry);
    persistClients();
    console.log(`[oauth] register client="${clientId}" redirects=${redirectUris.length} ip=${req.socket?.remoteAddress || '?'}`);
    rawJson(res, 201, {
      client_id: clientId,
      client_id_issued_at: entry.issuedAt,
      client_name: entry.client_name,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: allScopes().join(' '),
    });
    return true;
  }

  if (pathname === '/authorize/complete' && req.method === 'POST') {
    const form = await readForm(req);
    const query = new Map();
    for (const [key, value] of form) {
      if (key !== 'password' && key !== 'grant') query.set(key, value);
    }
    const params = new URLSearchParams(query);

    if (!safeEqual(form.get('password') || '', config.oauthPassword)) {
      console.log(`[oauth] authorize complete WRONG PASSWORD ip=${req.socket?.remoteAddress || '?'} ua="${(req.headers['user-agent'] || '?').slice(0, 90)}"`);
      html(res, 401, page('OpenCode bridge', '<h1>Wrong password</h1><p>Check BRIDGE_OAUTH_PASSWORD in the bridge .env.</p><p><a href="javascript:history.back()">Go back</a></p>'));
      return true;
    }

    const error = validateAuthorizeQuery(params);
    if (error) {
      console.log(`[oauth] authorize complete REJECTED ip=${req.socket?.remoteAddress || '?'} reason=${error}`);
      html(res, 400, page('OpenCode bridge', `<h1>Cannot authorize</h1><p>${error}</p>`));
      return true;
    }

    // Only powers the user explicitly ticked (and that the bridge enables) are granted.
    const allowed = new Set(enabledCapabilities().map((capability) => capability.scope));
    const checked = new Set(form.getAll('grant'));
    const wanted = String(params.get('scope') || '').split(/\s+/).filter(Boolean);
    const scopes = [SCOPES.read, ...[...checked].filter((scope) => allowed.has(scope))];
    if (wanted.length) {
      const filtered = scopes.filter((scope) => wanted.includes(scope));
      if (filtered.length) scopes.splice(0, scopes.length, ...filtered);
    }

    let redirectHost = '?';
    try { redirectHost = new URL(params.get('redirect_uri')).host; } catch {}
    console.log(`[oauth] authorize complete OK client=${params.get('client_id') || '?'} scopes=${scopes.join(' ')} redirect_host=${redirectHost} ip=${req.socket?.remoteAddress || '?'}`);

    const code = randomBytes(32).toString('base64url');
    codes.set(code, {
      clientId: params.get('client_id'),
      redirectUri: params.get('redirect_uri'),
      challenge: params.get('code_challenge'),
      scopes,
      resource: params.get('resource') || null,
      exp: Math.floor(Date.now() / 1000) + CODE_TTL,
    });

    const target = new URL(params.get('redirect_uri'));
    target.searchParams.set('code', code);
    if (params.get('state')) target.searchParams.set('state', params.get('state'));
    res.writeHead(302, { location: target.toString() });
    res.end();
    return true;
  }

  if (pathname === '/token' && req.method === 'POST') {
    const form = await readForm(req);
    const clientId = form.get('client_id') || '';
    if (!isKnownClient(clientId)) {
      console.log(`[oauth] token FAILED unknown client="${clientId || '?'}" ip=${req.socket?.remoteAddress || '?'} ua="${(req.headers['user-agent'] || '?').slice(0, 90)}"`);
      rawJson(res, 401, { error: 'invalid_client', error_description: `Unknown client_id "${clientId}".` });
      return true;
    }

    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const entry = codes.get(form.get('code'));
      if (!entry) {
        console.log(`[oauth] token code FAILED client=${clientId} reason=code-expired-or-used ip=${req.socket?.remoteAddress || '?'}`);
        rawJson(res, 400, { error: 'invalid_grant', error_description: 'Code expired or already used.' });
        return true;
      }
      if (entry.clientId !== clientId || entry.redirectUri !== form.get('redirect_uri')) {
        console.log(`[oauth] token code FAILED client=${clientId} reason=redirect-mismatch ip=${req.socket?.remoteAddress || '?'}`);
        rawJson(res, 400, { error: 'invalid_grant', error_description: 'client_id/redirect_uri mismatch.' });
        return true;
      }
      if (s256(form.get('code_verifier') || '') !== entry.challenge) {
        console.log(`[oauth] token code FAILED client=${clientId} reason=pkce-verifier ip=${req.socket?.remoteAddress || '?'}`);
        rawJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE code_verifier rejected.' });
        return true;
      }
      codes.delete(form.get('code'));
      persist();
      console.log(`[oauth] token code OK client=${clientId} scopes=${entry.scopes.join(' ')} ip=${req.socket?.remoteAddress || '?'}`);
      rawJson(res, 200, issueTokens({ clientId, scopes: entry.scopes, resource: entry.resource }));
      return true;
    }

    if (grant === 'refresh_token') {
      const refresh = pendingRefreshToken(form.get('refresh_token'));
      if (!refresh || refresh.clientId !== clientId) {
        console.log(`[oauth] token refresh FAILED client=${clientId} (missing/expired/rotated) ip=${req.socket?.remoteAddress || '?'}`);
        rawJson(res, 400, { error: 'invalid_grant', error_description: 'Refresh token missing, expired, or already rotated.' });
        return true;
      }
      refreshTokens.delete(form.get('refresh_token'));
      const resource = form.get('resource') || refresh.resource;
      console.log(`[oauth] token refresh OK client=${clientId} scopes=${refresh.scopes ? refresh.scopes.join(' ') : '?'} ip=${req.socket?.remoteAddress || '?'}`);
      rawJson(res, 200, issueTokens({ clientId, scopes: refresh.scopes, resource }));
      return true;
    }

    console.log(`[oauth] token unsupported grant="${grant || '?'}" client=${clientId || '?'} ip=${req.socket?.remoteAddress || '?'}`);
    rawJson(res, 400, { error: 'unsupported_grant_type', error_description: 'Use authorization_code or refresh_token.' });
    return true;
  }

  return false;
}

function pendingRefreshToken(token) {
  load();
  ipcCleanup();
  return refreshTokens.get(token);
}

export function mcpAuthChallenge(res, origin) {
  if (!oauthEnabled()) {
    rawJson(res, 401, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized. Send "Authorization: Bearer <BRIDGE_TOKEN>".' },
      id: null,
    });
    return;
  }
  rawJson(
    res,
    401,
    {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'OAuth required. See WWW-Authenticate metadata.' },
      id: null,
    },
    {
      'www-authenticate': `Bearer realm="opencode", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  );
}

export function describe() {
  if (oauthEnabled()) return 'OAuth (local password + PKCE)';
  if (config.token) return 'static Bearer token';
  return 'none (URL is the secret)';
}
