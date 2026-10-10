/**
 * NEXORA bridge — protocol, validation, auth and safety tests.
 * Run: node --test bridge/test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateConfig, redact } from '../src/config.mjs';
import { createServer, callTool, TOOLS, createAudit } from '../src/server.mjs';
import { BridgeError } from '../src/opencode-client.mjs';

// ---------------------------------------------------------------- config

test('validateConfig rejects an unsupported transport', () => {
  const r = validateConfig({ transport: 'carrier-pigeon', bridgeToken: 'x', limits: { maxOutputBytes: 4096, maxTaskChars: 100 } });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /BRIDGE_TRANSPORT/);
});

test('validateConfig requires a token for the http transport', () => {
  const r = validateConfig({ transport: 'http', bridgeToken: '', limits: { maxOutputBytes: 4096, maxTaskChars: 100 } });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /BRIDGE_TOKEN/);
});

test('validateConfig accepts stdio without a token', () => {
  const r = validateConfig({ transport: 'stdio', bridgeToken: '', limits: { maxOutputBytes: 4096, maxTaskChars: 100 } });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------- redaction

test('redact removes configured secrets', () => {
  const cfg = { opencode: { password: 'hunter2secret' }, bridgeToken: 'tok-abc-123' };
  const out = redact('pw=hunter2secret bearer=tok-abc-123', cfg);
  assert.ok(!out.includes('hunter2secret'));
  assert.ok(!out.includes('tok-abc-123'));
});

test('redact removes github/openai token shapes and hex private keys', () => {
  const out = redact('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa sk-bbbbbbbbbbbbbbbbbbbbbb 0x' + 'ab'.repeat(32));
  assert.ok(!out.includes('ghp_aaaa'));
  assert.ok(!out.includes('sk-bbbb'));
  assert.ok(!out.includes('ab'.repeat(32)));
});

// ---------------------------------------------------------------- protocol

test('initialize advertises tools capability and server identity', async () => {
  const handle = createServer();
  const res = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.result.serverInfo.name, 'nexora-opencode-bridge');
  assert.ok(res.result.capabilities.tools);
});

test('tools/list exposes exactly the allowlisted tools', async () => {
  const handle = createServer();
  const res = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'bridge_health', 'nexora_diff', 'nexora_docs_index', 'nexora_git_status',
    'nexora_log', 'opencode_cancel_task', 'opencode_list_sessions',
    'opencode_submit_task', 'opencode_task_status'
  ]);
});

test('only submit and cancel are marked as write tools', () => {
  const write = TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(write, ['opencode_cancel_task', 'opencode_submit_task']);
});

test('unknown method returns a JSON-RPC error, not a crash', async () => {
  const handle = createServer();
  const res = await handle({ jsonrpc: '2.0', id: 3, method: 'does/not/exist' });
  assert.equal(res.error.code, -32601);
});

test('notifications/initialized returns no response body', async () => {
  const handle = createServer();
  const res = await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res, null);
});

test('ping responds', async () => {
  const handle = createServer();
  const res = await handle({ jsonrpc: '2.0', id: 4, method: 'ping' });
  assert.deepEqual(res.result, {});
});

// ---------------------------------------------------------------- tool errors

test('unknown tool returns a structured isError result', async () => {
  const res = await callTool('rm_rf_slash', {}, { audit: createAudit() });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /unknown_tool/);
});

test('submit rejects an over-long task instead of truncating it', async () => {
  const audit = createAudit();
  const res = await callTool('opencode_submit_task', { task: 'x'.repeat(50000) }, { audit });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /invalid_input|exceeds/);
});

test('submit can be disabled entirely', async () => {
  const cfg = await import('../src/config.mjs');
  const previous = cfg.config.allowSubmit;
  cfg.config.allowSubmit = false;
  try {
    const res = await callTool('opencode_submit_task', { task: 'hello' }, { audit: createAudit() });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /forbidden/);
  } finally {
    cfg.config.allowSubmit = previous;
  }
});

test('cancel can be disabled entirely', async () => {
  const cfg = await import('../src/config.mjs');
  const previous = cfg.config.allowCancel;
  cfg.config.allowCancel = false;
  try {
    const res = await callTool('opencode_cancel_task', {}, { audit: createAudit() });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /forbidden/);
  } finally {
    cfg.config.allowCancel = previous;
  }
});

test('diff rejects a ref containing shell-ish characters', async () => {
  const res = await callTool('nexora_diff', { ref: 'HEAD; rm -rf /' }, { audit: createAudit() });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /invalid_input/);
});

test('diff rejects a path filter containing ..', async () => {
  const res = await callTool('nexora_diff', { ref: 'HEAD', path: '../../etc' }, { audit: createAudit() });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /invalid_input/);
});

test('the bridge never exposes a shell-execution tool', () => {
  const forbidden = TOOLS.filter((t) => /exec|shell|command|run_|bash|script/i.test(t.name));
  assert.deepEqual(forbidden, []);
});

// ---------------------------------------------------------------- upstream handling

test('an unreachable OpenCode API produces a clear error, not a hang', async () => {
  const cfg = await import('../src/config.mjs');
  const previous = cfg.config.opencode.baseUrl;
  cfg.config.opencode.baseUrl = 'http://127.0.0.1:1'; // nothing listens here
  try {
    const res = await callTool('opencode_list_sessions', {}, { audit: createAudit() });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /upstream_unreachable|cannot reach/);
  } finally {
    cfg.config.opencode.baseUrl = previous;
  }
});

test('bridge_health works even when the OpenCode API is down', async () => {
  const cfg = await import('../src/config.mjs');
  const previous = cfg.config.opencode.baseUrl;
  cfg.config.opencode.baseUrl = 'http://127.0.0.1:1';
  try {
    const res = await callTool('bridge_health', {}, { audit: createAudit() });
    assert.equal(res.isError, false);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.apiReachable, false);
    assert.equal(payload.bridgeConfigValid, true);
  } finally {
    cfg.config.opencode.baseUrl = previous;
  }
});

test('BridgeError carries a machine-readable code', () => {
  const e = new BridgeError('nope', 'forbidden');
  assert.equal(e.code, 'forbidden');
  assert.ok(e instanceof Error);
});
