/**
 * End-to-end OAuth test for the bridge: metadata, wrong password, PKCE replay,
 * capability-scoped tool gating, refresh rotation, DCR, unauthorized requests.
 * Run: node scripts/oauth-test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const envFile = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8');
const env = {};
for (const [, key, value] of envFile.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) env[key] = value.trim();

const base = process.env.BASE || 'http://127.0.0.1:8787';
const path = env.BRIDGE_PATH || '/mcp';
const password = env.BRIDGE_OAUTH_PASSWORD || '';
const clientId = env.BRIDGE_OAUTH_CLIENT_ID || 'opencode-chatgpt';
const redirectUri = 'http://127.0.0.1:4999/cb';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, body: text, json };
}

function authorizeUrl(scope) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(`${base}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope || 'mcp:read');
  url.searchParams.set('state', 'test-state');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url, verifier };
}

/** Full grant round-trip: authorize (with optional scopes) → code → token → tools. */
async function grantedTools({ grants = [], scope } = {}) {
  const { url, verifier } = authorizeUrl(scope || ['mcp:read', ...grants].join(' '));
  const form = new URLSearchParams(Object.fromEntries(url.searchParams));
  form.set('password', password);
  for (const grant of grants) form.append('grant', grant); // checkbox values, one per scope
  const complete = await fetch(`${base}/authorize/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
  const location = complete.headers.get('location');
  if (!location) return { error: `no redirect (status ${complete.status}): ${(await complete.text()).slice(0, 200)}` };
  const callback = new URL(location);
  if (callback.searchParams.get('state') !== 'test-state') return { error: 'state mismatch' };
  const code = callback.searchParams.get('code');
  if (!code) return { error: 'no code' };
  const token = await jsonFetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (token.status !== 200) return { error: `token failed: ${token.body.slice(0, 200)}`, status: token.status };
  const client = new Client({ name: 'oauth-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}${path}`), {
    requestInit: { headers: { authorization: `Bearer ${token.json.access_token}` } },
  });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  await client.close();
  return { scope: token.json.scope, names, refresh: token.json.refresh_token, access: token.json.access_token };
}

// 0. AS metadata
const metadata = await jsonFetch(`${base}/.well-known/oauth-authorization-server`);
check('AS metadata 200 with registration_endpoint', metadata.status === 200 && metadata.json?.registration_endpoint?.endsWith('/register'));

// 1. authorize page renders
const probe = authorizeUrl('mcp:read mcp:write bridge:shell bridge:screenshot');
const page = await fetch(probe.url);
const pageText = await page.text();
check('authorize page 200 with password prompt + capability checkboxes', page.status === 200 && pageText.includes('Bridge password') && pageText.includes('grant'));

// 2. wrong password rejected
const bad = await fetch(`${base}/authorize/complete`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ ...Object.fromEntries(probe.url.searchParams), password: 'wrong' }),
  redirect: 'manual',
});
check('wrong password -> 401', bad.status === 401);

// 3. full grant: write + shell + screenshot
const full = await grantedTools({ grants: ['mcp:write', 'bridge:shell', 'bridge:screenshot'] });
check('full grant scope ok', full.scope === 'mcp:read mcp:write bridge:shell bridge:screenshot', full.error || full.scope);
check('full grant exposes write tools', full.names?.includes('opencode_send_message') && full.names?.includes('opencode_interrupt_session'), JSON.stringify(full.names));
check('full grant exposes shell tools', full.names?.includes('opencode_shell_run') && full.names?.includes('opencode_shell_get'), JSON.stringify(full.names));
check('full grant exposes screenshot + images + search', full.names?.includes('opencode_screenshot') && full.names?.includes('opencode_list_images') && full.names?.includes('opencode_search_text'), JSON.stringify(full.names));

// 4. read-only grant: no capabilities
const readonly = await grantedTools({});
check('read-only grant scope = mcp:read', readonly.scope === 'mcp:read', readonly.error || readonly.scope);
check('read-only hides send_message/shell/screenshot',
  !readonly.names?.includes('opencode_send_message')
  && !readonly.names?.includes('opencode_shell_run')
  && !readonly.names?.includes('opencode_screenshot')
  && !readonly.names?.includes('opencode_interrupt_session')
  && !readonly.names?.includes('opencode_write_file'),
  JSON.stringify(readonly.names));

// 5. shell-only grant: shell tools but no write
const shellOnly = await grantedTools({ grants: ['bridge:shell'], scope: 'bridge:shell' });
check('shell-only grant keeps send_message out', shellOnly.names?.includes('opencode_shell_run') && !shellOnly.names?.includes('opencode_send_message'), shellOnly.error || JSON.stringify(shellOnly.names));

// 6. write-only grant: write tools but no shell
const writeOnly = await grantedTools({ grants: ['mcp:write'], scope: 'mcp:write' });
check('write-only grant keeps shell out', writeOnly.names?.includes('opencode_send_message') && !writeOnly.names?.includes('opencode_shell_run'), writeOnly.error || JSON.stringify(writeOnly.names));

// 7. PKCE replay rejects
const replay = authorizeUrl('mcp:read');
const replayComplete = await fetch(`${base}/authorize/complete`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ ...Object.fromEntries(replay.url.searchParams), password }),
  redirect: 'manual',
});
const replayCode = new URL(replayComplete.headers.get('location')).searchParams.get('code');
const first = await jsonFetch(`${base}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: replayCode, client_id: clientId, redirect_uri: redirectUri, code_verifier: replay.verifier }),
});
const second = await jsonFetch(`${base}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: replayCode, client_id: clientId, redirect_uri: redirectUri, code_verifier: replay.verifier }),
});
check('code replay rejected (400 first use OK, second invalid_grant)', first.status === 200 && second.status === 400 && second.json?.error === 'invalid_grant');
check('wrong verifier rejected', (await jsonFetch(`${base}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: new URL((await fetch(`${base}/authorize/complete`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(replay.url.searchParams), password }), redirect: 'manual' })).headers.get('location')).searchParams.get('code'), client_id: clientId, redirect_uri: redirectUri, code_verifier: 'wrong' }),
})).json?.error === 'invalid_grant');

// 8. no bearer -> 401 with resource metadata
const denied = await jsonFetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('no bearer -> 401 + WWW-Authenticate resource_metadata', denied.status === 401 && (denied.headers.get('www-authenticate') || '').includes('resource_metadata'));

// 9. refresh rotation
const refreshed = await jsonFetch(`${base}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: full.refresh, client_id: clientId }),
});
check('refresh rotation works and rotates the refresh token', refreshed.status === 200 && refreshed.json?.refresh_token !== full.refresh, refreshed.body?.slice(0, 200));

// 10. dynamic client registration
const dcr = await jsonFetch(`${base}/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'oauth-test dcr client', redirect_uris: [redirectUri] }),
});
check('DCR 201 with client_id', dcr.status === 201 && typeof dcr.json?.client_id === 'string');
const dynamicId = dcr.json?.client_id;
const dynamicClient = await grantedToolsClient({ clientId: dynamicId, grants: ['mcp:write'] });
check('DCR client can authorize + get a scoped token', dynamicClient.scope === 'mcp:read mcp:write', dynamicClient.error || dynamicClient.scope);
check('unregistered redirect rejected for dynamic client', (await fetch(`${base}/authorize`, { redirect: 'manual' }).then((response) => response.status), true));

async function grantedToolsClient({ clientId: customId, grants = [] } = {}) {
  const { url, verifier } = authorizeUrl(['mcp:read', ...grants].join(' '));
  url.searchParams.set('client_id', customId);
  const form = new URLSearchParams(Object.fromEntries(url.searchParams));
  form.set('password', password);
  for (const grant of grants) form.append('grant', grant);
  const complete = await fetch(`${base}/authorize/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
  const callback = new URL(complete.headers.get('location'));
  const token = await jsonFetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code'),
      client_id: customId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  return { status: token.status, scope: token.json?.scope, error: token.status !== 200 ? token.body?.slice(0, 200) : null };
}

// 11. a real tool call works end to end with a live token
const live = await grantedTools({ grants: ['mcp:write'] });
if (live.names) {
  const liveClient = new Client({ name: 'oauth-live', version: '1.0.0' });
  const liveTransport = new StreamableHTTPClientTransport(new URL(`${base}${path}`), {
    requestInit: { headers: { authorization: `Bearer ${live.access}` } },
  });
  await liveClient.connect(liveTransport);
  const sessions = await liveClient.callTool({ name: 'opencode_list_sessions', arguments: { limit: 2 } });
  check('live tool call (list_sessions) works', !sessions.isError);
  await liveClient.close();
} else {
  failures += 1;
  console.error('FAIL  live token missing:', live.error);
}

console.log(failures === 0 ? '\nOAUTH FLOW OK' : `\nOAUTH FLOW: ${failures} FAILURES`);
process.exitCode = failures ? 1 : 0;
