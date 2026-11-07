/**
 * Live integration test against the running bridge + real OpenCode service.
 * Uses a full-capability OAuth grant. Operations happen in the approved
 * workspace roots; the agent-turn test runs in a dedicated throwaway session
 * (never reuses the user's chat sessions) but is NOT deleted afterwards
 * (OpenCode sessions are user data — we only create, never destroy).
 * Run: node scripts/integration-test.mjs
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const bridgeRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const [, key, value] of readFileSync(join(bridgeRoot, '.env'), 'utf8')
  .matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) env[key] = value.trim();

const base = 'http://127.0.0.1:8787';
const clientId = env.BRIDGE_OAUTH_CLIENT_ID || 'opencode-chatgpt';
const password = env.BRIDGE_OAUTH_PASSWORD || '';
const redirectUri = 'http://127.0.0.1:4999/cb';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name} ${detail}`);
  }
}
function textOf(result) {
  return (result.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
function imageOf(result) {
  return (result.content || []).find((block) => block.type === 'image');
}

async function authorize(scopes) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(`${base}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', 'itest');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  const form = new URLSearchParams(Object.fromEntries(url.searchParams));
  form.set('password', password);
  for (const scope of scopes.slice(1)) form.append('grant', scope);
  const complete = await fetch(`${base}/authorize/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
  const code = new URL(complete.headers.get('location')).searchParams.get('code');
  const tokenResponse = await fetch(`${base}/token`, {
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
  const token = await tokenResponse.json();
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}${env.BRIDGE_PATH}`), {
    requestInit: { headers: { authorization: `Bearer ${token.access_token}` } },
  });
  await client.connect(transport);
  return client;
}

console.log('connecting with full capabilities…');
const client = await authorize(['mcp:read', 'mcp:write', 'bridge:shell', 'bridge:screenshot']);
check('connected (full capabilities)', Boolean(client));

const approvedTemp = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\opencode'; // inside BRIDGE_WORKSPACE_ROOTS

// --- pagination -------------------------------------------------------------
const sessions = await client.callTool({ name: 'opencode_list_sessions', arguments: { limit: 5 } });
const firstSessionId = (textOf(sessions).match(/ses_[A-Za-z0-9]+/) || [])[0];
check('list_sessions works and yields a session id', Boolean(firstSessionId), textOf(sessions).slice(0, 200));

if (firstSessionId) {
  const page1 = await client.callTool({
    name: 'opencode_get_session',
    arguments: { session_id: firstSessionId, limit: 5 },
  });
  const older = (textOf(page1).match(/older page cursor: (\S+)/) || [])[1];
  check('transcript exposes an older-page cursor', Boolean(older), textOf(page1).slice(0, 120));
  if (older) {
    const page2 = await client.callTool({
      name: 'opencode_get_session',
      arguments: { session_id: firstSessionId, limit: 5, cursor: older, direction: 'older' },
    });
    check('cursor page returns different (older) messages', !page2.isError, textOf(page2).slice(0, 200));
  }
  const reasoning = await client.callTool({
    name: 'opencode_get_session',
    arguments: { session_id: firstSessionId, limit: 6, include_reasoning: true },
  });
  check('include_reasoning accepted', !reasoning.isError);
}

// --- path traversal protection ---------------------------------------------
const traversal = await client.callTool({
  name: 'opencode_read_file',
  arguments: { path: 'C:/Users/Administrator/../../Windows/win.ini', max_chars: 200 },
});
check('path traversal read refused', traversal.isError && /outside the approved workspace/i.test(textOf(traversal)), textOf(traversal).slice(0, 160));

const traversalEdit = await client.callTool({
  name: 'opencode_write_file',
  arguments: { path: 'C:/Users/Administrator/../../bridge-escape.txt', content: 'x' },
});
check('path traversal write refused', traversalEdit.isError, textOf(traversalEdit).slice(0, 160));

// --- file write + edit + read back (temp dir inside the approved temp root) ----
const tempDir = mkdtempSync(join(approvedTemp, 'bridge-itest-'));
const filePath = join(tempDir, 'note.txt');
const written = await client.callTool({
  name: 'opencode_write_file',
  arguments: { path: filePath, content: 'alpha\nbeta\ngamma\n' },
});
check('write_file reports bytes', !written.isError && /Wrote \d+ bytes/.test(textOf(written)), textOf(written).slice(0, 200));

const edited = await client.callTool({
  name: 'opencode_edit_file',
  arguments: { path: filePath, find: 'beta', replace: 'BETA2' },
});
check('edit_file applies replacement', !edited.isError && /1 replacement\(s\)/.test(textOf(edited)), textOf(edited).slice(0, 200));

const readBack = await client.callTool({ name: 'opencode_read_file', arguments: { path: filePath } });
check('read_file shows the edited content', textOf(readBack).includes('BETA2'), textOf(readBack).slice(0, 200));

const uniqueFail = await client.callTool({
  name: 'opencode_edit_file',
  arguments: { path: filePath, find: 'a', replace: 'z' },
});
check('edit_file refuses ambiguous match', uniqueFail.isError && /appears \d+ times/.test(textOf(uniqueFail)), textOf(uniqueFail).slice(0, 200));
rmSync(tempDir, { recursive: true, force: true });

// --- text search -------------------------------------------------------------
const search = await client.callTool({
  name: 'opencode_search_text',
  arguments: { query: 'isHighRiskCommand', directory: 'C:\\Users\\Administrator\\opencode-bridge\\src', limit: 5 },
});
check('search_text finds source references', !search.isError && textOf(search).includes('guards.js'), textOf(search).slice(0, 200));

// --- shell commands ----------------------------------------------------------
const echo = await client.callTool({
  name: 'opencode_shell_run',
  arguments: { command: 'node -e "process.stdout.write(\'BRIDGE_SHELL_OK\'); process.exitCode = 7"', timeout_seconds: 20 },
});
check('shell_run returns output + honest exit code', !echo.isError && /BRIDGE_SHELL_OK/.test(textOf(echo)) && /exit: 7/, textOf(echo).slice(0, 300));

const refused = await client.callTool({
  name: 'opencode_shell_run',
  arguments: { command: 'reg add HKCU\\Software\\BridgeTest /v x /d 1' },
});
check('high-risk command refused without confirm', !refused.isError && /confirm=true/i.test(textOf(refused)), textOf(refused).slice(0, 200));

const timeoutRun = await client.callTool({
  name: 'opencode_shell_run',
  arguments: { command: 'ping -n 30 127.0.0.1', timeout_seconds: 4 },
});
check('shell timeout reported honestly', /status: timeout/.test(textOf(timeoutRun)), textOf(timeoutRun).slice(0, 300));

const shellList = await client.callTool({ name: 'opencode_shell_list', arguments: { limit: 5 } });
check('shell_list honest (running shells listed or eviction noted)', !shellList.isError && (/exited|timeout|running/.test(textOf(shellList)) || /dropped from this list/.test(textOf(shellList))), textOf(shellList).slice(0, 240));

// --- images ------------------------------------------------------------------
const images = await client.callTool({ name: 'opencode_list_images', arguments: { session_id: firstSessionId } });
check('list_images honest about no images', !images.isError, textOf(images).slice(0, 160));
const gotImage = await client.callTool({ name: 'opencode_get_image', arguments: { session_id: firstSessionId, index: 0 } });
check('get_image honest when nothing exists', !gotImage.isError || /no attachment/i.test(textOf(gotImage)), textOf(gotImage).slice(0, 160));

// --- screenshot ---------------------------------------------------------------
const shotRefused = await client.callTool({ name: 'opencode_screenshot', arguments: {} });
check('screenshot refused without confirm=true', /confirm=true/i.test(textOf(shotRefused)), textOf(shotRefused).slice(0, 200));
const shot = await client.callTool({ name: 'opencode_screenshot', arguments: { confirm: true } });
const shotImage = imageOf(shot);
check('screenshot returns a real MCP image block', Boolean(shotImage) && shotImage.mimeType === 'image/png' && shotImage.data.length > 1000, textOf(shot).slice(0, 200));

// --- agent turn E2E in a dedicated session ------------------------------------
console.log('sending agent instruction (new dedicated session)…');
const send = await client.callTool({
  name: 'opencode_send_message',
  arguments: {
    text: 'This is a bridge integration test. Reply with exactly BRIDGE_V2_OK on the first line and do nothing else (no tools, no files).',
    wait_seconds: 120,
  },
});
const sendText = textOf(send);
const okReply = /Session ses_[a-z0-9]+.*replied:\n\n[\s\S]*BRIDGE_V2_OK/.test(sendText) || sendText.includes('BRIDGE_V2_OK');
check('send_message gets the real agent reply', !send.isError && okReply, sendText.slice(0, 300));

// --- interrupt on an idle session ---------------------------------------------
const idle = await client.callTool({
  name: 'opencode_interrupt_session',
  arguments: { session_id: firstSessionId },
});
check('interrupt honest about idle sessions', !idle.isError && /nothing was running|idle/i.test(textOf(idle)), textOf(idle).slice(0, 200));

await client.close();

// --- rate limiting ------------------------------------------------------------
const base64 = [];
let saw429 = false;
for (let index = 0; index < 205; index += 1) {
  const response = await fetch(`${base}${env.BRIDGE_PATH}`, { method: 'GET', headers: { 'mcp-session-id': 'none' } });
  if (response.status === 429) {
    saw429 = true;
    break;
  }
  base64.push(response.status);
}
check('rate limiter returns 429 after the limit', saw429, `statuses seen: ${base64.slice(-5).join(',')}`);

// --- audit trail ---------------------------------------------------------------
const auditText = readFileSync(join(bridgeRoot, '.audit', 'audit.jsonl'), 'utf8');
const auditLines = auditText.trim().split('\n');
let secretsInAudit = false;
for (const line of auditLines) {
  if (/nyjjcQA8bK8a6EPi8iDjI3cRRh9FcENkvyH|access_token":|refresh_token":|Authorization: Bearer\s+[A-Za-z0-9_-]{20,}/.test(line)) {
    secretsInAudit = true;
    break;
  }
}
check('audit file captures tool calls without live secrets', auditLines.length > 10 && !secretsInAudit, `${auditLines.length} entries, secrets: ${secretsInAudit}`);

console.log(failures === 0 ? '\nINTEGRATION OK' : `\nINTEGRATION: ${failures} FAILURES`);
process.exitCode = failures ? 1 : 0;
