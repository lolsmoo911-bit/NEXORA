/**
 * NEXORA bridge — end-to-end smoke test.
 *
 * 1. Start a FAKE OpenCode API (loopback, ephemeral port) that speaks the subset of the
 *    documented server API this bridge uses.
 * 2. Start the bridge against it in --http mode on loopback.
 * 3. Prove: wrong token is rejected; correct token gets health; a task submitted from the
 *    "reviewer" side lands on the fake agent; the agent's reply is read back.
 * 4. Prove: repository tools return real data from the actual workspace.
 *
 * This is a real bidirectional test of the transport. It does NOT claim that a ChatGPT
 * custom connector is connected; that requires the owner's one-time connector setup.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const indexPath = path.join(here, '..', 'src', 'index.mjs');

const TOKEN = 'test-bridge-token-not-a-real-secret';
const V = '2026-07-28';
let failures = 0;
function check(name, cond, extra = '') {
  const ok = Boolean(cond);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

/** Post a JSON-RPC message to the bridge exactly as a conformant MCP client would. */
async function rpc(port, message, { token = TOKEN, extraHeaders = {}, path = '/mcp' } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': V,
      authorization: 'Bearer ' + token,
      ...extraHeaders
    },
    body: JSON.stringify(message)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: res.status, json, text };
}

// ---- fake OpenCode API ----
// Deliberately FAITHFUL to the documented server behaviour: POST /session/:id/message is
// "send a message and wait for response", so a request WITHOUT noReply:true must come back
// with an assistant message that is actually stored in the session. A fake that merely
// echoed the user message would have hidden the defect this bridge used to have.
const received = [];
const store = [];
let seq = 0;
const fake = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.url === '/global/health') return send(200, { healthy: true, version: 'fake' });
  if (req.url === '/session' && req.method === 'GET') {
    return send(200, [{ id: 'ses_fake_1', title: 'NEXORA session', updated: '2026-10-10T00:00:00Z' }]);
  }
  if (req.url === '/session/ses_fake_1/message' && req.method === 'POST') {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
    received.push(parsed);
    seq++;
    const userId = parsed?.messageID || 'msg_user_' + seq;
    store.push({
      info: { id: userId, role: 'user', time: { created: '2026-10-10T00:00:00Z' } },
      parts: parsed?.parts || []
    });
    if (parsed?.noReply === true) {
      // Exactly what the real server does when told not to reply: store, run nothing.
      return send(200, { info: store[store.length - 1].info, parts: store[store.length - 1].parts });
    }
    const assistantId = 'msg_fake_assistant_' + seq;
    const replyText = 'Acknowledged: I will inspect the NEXORA repository.';
    store.push({
      info: { id: assistantId, role: 'assistant', parentID: userId, time: { created: '2026-10-10T00:00:01Z' } },
      parts: [{ type: 'text', text: replyText }]
    });
    return send(200, {
      info: { id: assistantId, role: 'assistant', parentID: userId },
      parts: [{ type: 'text', text: replyText }]
    });
  }
  if (req.url === '/session/ses_fake_1/message' && req.method === 'GET') {
    return send(200, store);
  }
  return send(404, { error: 'not found' });
});

await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const fakePort = fake.address().port;

// ---- bridge ----
const bridge = spawn(process.execPath, [indexPath, '--http'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    BRIDGE_TRANSPORT: 'http',
    BRIDGE_TOKEN: TOKEN,
    BRIDGE_PORT: '0',
    NEXORA_WORKSPACE: repoRoot,
    OPENCODE_BASE_URL: `http://127.0.0.1:${fakePort}`
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let bridgeLog = '';
bridge.stderr.on('data', (d) => { bridgeLog += d.toString(); });
bridge.stdout.on('data', () => {});

// the bridge picks a port from BRIDGE_PORT; ask it which one by reading the log line
let bridgePort = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 100));
  const m = bridgeLog.match(/127\.0\.0\.1:(\d+)/);
  if (m) { bridgePort = Number(m[1]); break; }
}
check('bridge started on loopback', Boolean(bridgePort), bridgeLog.trim());

if (bridgePort) {
  // 1. auth failure
  const bad = await rpc(bridgePort, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: 'wrong-token' });
  check('wrong bearer token is rejected with 401', bad.status === 401, `got ${bad.status}`);

  // 2. protocol
  const init = await rpc(bridgePort, { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
  check('initialize works over http', init.json?.result?.serverInfo?.name === 'nexora-opencode-bridge');

  const tools = await rpc(bridgePort, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const toolNames = (tools.json?.result?.tools || []).map((t) => t.name);
  check('tools/list returns 9 tools', toolNames.length === 9, `got ${toolNames.length}`);

  // 3. health through the bridge
  const health = await rpc(bridgePort, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'bridge_health', arguments: {} }
  });
  const healthPayload = JSON.parse(health.json.result.content[0].text);
  check('bridge_health reports the fake OpenCode API reachable', healthPayload.apiReachable === true,
    `healthy=${healthPayload.api?.healthy}`);

  // 3b. MCP notification must be accepted with 202 and no body
  const note = await rpc(bridgePort, { jsonrpc: '2.0', method: 'notifications/initialized' });
  check('a JSON-RPC notification is accepted with 202 and no body', note.status === 202 && note.text === '',
    `status=${note.status} len=${note.text.length}`);

  // 4. reviewer -> agent (inbound)
  const submit = await rpc(bridgePort, {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'opencode_submit_task', arguments: { task: 'Inspect the NEXORA repo and report git status.' } }
  });
  check('submit_task succeeded', submit.json?.result?.isError === false,
    submit.json?.result?.isError ? String(submit.json.result.content[0].text).slice(0, 160) : '');
  const submitPayload = submit.json?.result?.isError === false
    ? JSON.parse(submit.json.result.content[0].text) : {};
  check('submit_task reports that the MODEL RAN (not merely that the text was saved)',
    submitPayload.modelRan === true && Boolean(submitPayload.assistantMessageId),
    `assistantMessageId=${submitPayload.assistantMessageId}`);
  check('noReply was NOT sent, so the model run was not suppressed',
    received.length === 1 && !('noReply' in received[0]),
    JSON.stringify(received[0] || {}).slice(0, 160));
  check('the agent actually received the task text',
    received.length === 1 && received[0]?.parts?.[0]?.text?.includes('Inspect the NEXORA repo'),
    JSON.stringify(received).slice(0, 160));

  // 5. agent -> reviewer (outbound)
  const status = await rpc(bridgePort, {
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'opencode_task_status', arguments: {} }
  });
  const statusPayload = JSON.parse(status.json.result.content[0].text);
  check('reviewer can read the agent reply back',
    statusPayload?.assistantText?.includes('Acknowledged'),
    JSON.stringify({ state: statusPayload?.state, text: String(statusPayload?.assistantText || '').slice(0, 80) }));
  check('task state is reported as completed, not merely persisted',
    statusPayload?.state === 'completed', `state=${statusPayload?.state}`);

  // 6. repository tools return real workspace data
  const gitStatus = await rpc(bridgePort, {
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'nexora_git_status', arguments: {} }
  });
  const st = JSON.parse(gitStatus.json.result.content[0].text);
  check('nexora_git_status reports a branch and a real sha',
    Boolean(st.branch) && /^[0-9a-f]{40}$/.test(st.head?.sha || ''), `branch=${st.branch}`);

  const log = await rpc(bridgePort, {
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'nexora_log', arguments: { limit: 3 } }
  });
  const lg = JSON.parse(log.json.result.content[0].text);
  check('nexora_log returns bounded recent commits', Array.isArray(lg.commits) && lg.commits.length > 0);

  const diff = await rpc(bridgePort, {
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'nexora_diff', arguments: { ref: 'HEAD' } }
  });
  const df = JSON.parse(diff.json.result.content[0].text);
  check('nexora_diff returns a bounded diff', typeof df.diff === 'string');

  // 7. dangerous ref is refused
  const evil = await rpc(bridgePort, {
    jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name: 'nexora_diff', arguments: { ref: 'HEAD; whoami' } }
  });
  check('a shell-ish git ref is refused', evil.json?.result?.isError === true);

  // 8. unknown tool
  const nope = await rpc(bridgePort, {
    jsonrpc: '2.0', id: 11, method: 'tools/call',
    params: { name: 'not_a_tool', arguments: {} }
  });
  check('an unknown tool is refused structurally', nope.json?.result?.isError === true);
}

bridge.kill('SIGTERM');
fake.close();
console.log(failures === 0 ? '\nSMOKE TEST PASSED' : `\nSMOKE TEST FAILED (${failures} checks)`);
process.exit(failures === 0 ? 0 : 1);
