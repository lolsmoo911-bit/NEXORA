// Dedicated end-to-end smoke for the write path: sends an agent message and waits
// for the real reply. Requires a live OpenCode session id (or create one first via
// `opencode` CLI) plus the OAuth password from .env (full-capability grant).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const bridgeRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const [, key, value] of readFileSync(join(bridgeRoot, '.env'), 'utf8').matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) env[key] = value.trim();

const origin = 'http://127.0.0.1:8787';
const url = new URL(process.env.BRIDGE_URL || `${origin}${env.BRIDGE_PATH || '/mcp'}`);
const session = process.env.SESSION_ID || process.argv[2] || env.SESSION_ID;
// Omitting a session id is intentional here: send_message creates a dedicated
// session in that case, so the smoke test never writes into the user's own chat.
const scopes = ['mcp:read', 'mcp:write', 'bridge:shell', 'bridge:screenshot'];

async function oauthHeader() {
  const clientId = env.BRIDGE_OAUTH_CLIENT_ID || 'opencode-chatgpt';
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(`${origin}/authorize`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', 'http://127.0.0.1:4999/cb');
  authorize.searchParams.set('scope', scopes.join(' '));
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  const form = new URLSearchParams(Object.fromEntries(authorize.searchParams));
  form.set('password', env.BRIDGE_OAUTH_PASSWORD || '');
  for (const scope of scopes) form.append('grant', scope);
  const complete = await fetch(`${origin}/authorize/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
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
  return token.access_token ? `Bearer ${token.access_token}` : undefined;
}

const authorization = await oauthHeader();
if (!authorization) {
  console.error('OAuth token acquisition failed (check BRIDGE_OAUTH_PASSWORD in .env).');
  process.exit(1);
}

const client = new Client({ name: 'bridge-write-test', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { authorization } },
});
await client.connect(transport);
console.log('CONNECTED');

const wait = Number(process.env.WAIT_SECONDS || 120);
const started = Date.now();
const result = await client.callTool(
  {
    name: 'opencode_send_message',
    arguments: {
      text: 'This is a bridge write-path smoke test. Reply with exactly BRIDGE_V2_OK on the first line and do nothing else (no tools, no files).',
      wait_seconds: wait,
    },
  },
  undefined,
  { timeout: Math.max(200_000, (wait + 80) * 1000) },
);
const text = result.content?.map((item) => item.text || '').join('\n') || '';
console.log(`\n=== send_message (${Date.now() - started} ms)${result.isError ? ' [ERROR]' : ''}\n${text.slice(0, 2500)}`);

await client.close();
console.log('\nCLOSED');
process.exit(0);
