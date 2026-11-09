import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const bridgeRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const [, key, value] of readFileSync(join(bridgeRoot, '.env'), 'utf8').matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) env[key] = value.trim();
const dbg = process.env.SMOKE_DEBUG === '1';

const url = new URL(process.env.BRIDGE_URL || `http://127.0.0.1:8787${env.BRIDGE_PATH || '/mcp'}`);

async function bearerToken() {
  // OAuth-enabled bridge: run the local password grant to obtain a token.
  if (!env.BRIDGE_OAUTH_PASSWORD) return undefined;
  const password = env.BRIDGE_OAUTH_PASSWORD;
  const clientId = env.BRIDGE_OAUTH_CLIENT_ID || 'opencode-chatgpt';
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const origin = new URL(url).origin;
  const authorize = new URL(`${origin}/authorize`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', 'http://127.0.0.1:4999/cb');
  authorize.searchParams.set('scope', 'mcp:read');
  authorize.searchParams.set('state', 'smoke');
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  const form = new URLSearchParams(Object.fromEntries(authorize.searchParams));
  form.set('password', password);
  const complete = await fetch(`${origin}/authorize/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
  if (dbg) console.error(`[dbg] complete status=${complete.status} redirect=${complete.headers.get('location') ? 'yes' : 'NO'}`);
  const code = new URL(complete.headers.get('location')).searchParams.get('code');
  const tokenResponse = await fetch(`${origin}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:4999/cb',
      code_verifier: verifier,
    }),
  });
  const token = await tokenResponse.json();
  if (dbg) console.error(`[dbg] token status=${tokenResponse.status} access_token=${token.access_token ? 'present' : 'ABSENT'} scope=${token.scope}`);
  return token.access_token ? `Bearer ${token.access_token}` : undefined;
}

const authorization = process.env.BRIDGE_TOKEN ? `Bearer ${process.env.BRIDGE_TOKEN}` : await bearerToken();
if (dbg) console.error(`[dbg] authorization=${authorization ? 'set' : 'NONE'} | url=${url.origin}${url.pathname.length}chars`);
const client = new Client({ name: 'bridge-smoke-test', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: authorization ? { headers: { authorization } } : undefined,
});

await client.connect(transport).catch((error) => {
  console.error(`CONNECT FAILED: ${error.message}`);
  if (/\b401\b/.test(error.message)) {
    console.error('This bridge requires OAuth. Run: node scripts/oauth-test.mjs (or give BRIDGE_TOKEN in .env).');
  }
  process.exit(1);
});
console.log('CONNECTED');

const tools = await client.listTools();
console.log('TOOLS', tools.tools.map((tool) => tool.name).join(', '));

async function call(name, args) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.map((item) => item.text || '').join('\n') || '';
  console.log(`\n=== ${name} (${Date.now() - started} ms)${result.isError ? ' [ERROR]' : ''}\n${text.slice(0, 1500)}`);
  return text;
}

const sessions = await call('opencode_list_sessions', { limit: 3 });
const match = sessions.match(/ses_[A-Za-z0-9]+/);
if (match) {
  await call('opencode_get_session', { session_id: match[0], limit: 5, tool_output_chars: 300 });
}
await call('opencode_recent_events', { limit: 5 });
await call('opencode_list_files', { path: 'C:/Users/Administrator/opencode-bridge' });

await client.close();
console.log('\nCLOSED');
process.exit(0);
