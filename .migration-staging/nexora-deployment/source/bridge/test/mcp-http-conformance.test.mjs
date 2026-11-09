/**
 * NEXORA bridge — MCP Streamable HTTP conformance tests.
 *
 * Encodes the requirements from the current MCP transport specification:
 *   https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http
 *
 * Each assertion maps to a numbered requirement in that document, so a failure names
 * the exact clause that regressed.
 *
 * The tests drive the REAL handler over a REAL socket, temporarily swapping the
 * module-level config object between cases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { config } from '../src/config.mjs';
import { createHttpHandler, checkOrigin, negotiateProtocolVersion } from '../src/http.mjs';

const V = '2026-07-28';
const TOKEN = 'conformance-token-value';

// ---- config swapping -------------------------------------------------------------
async function withConfig(overrides, fn) {
  const saved = {
    bridgeToken: config.bridgeToken,
    mcp: JSON.parse(JSON.stringify(config.mcp)),
    limits: JSON.parse(JSON.stringify(config.limits))
  };
  config.bridgeToken = TOKEN;
  if (overrides.mcp) Object.assign(config.mcp, overrides.mcp);
  if (overrides.limits) Object.assign(config.limits, overrides.limits);
  try {
    return await fn();
  } finally {
    config.bridgeToken = saved.bridgeToken;
    Object.assign(config.mcp, saved.mcp);
    Object.assign(config.limits, saved.limits);
  }
}

async function startBridge() {
  const handler = createHttpHandler({});
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

function request(port, { body, raw, headers = {}, method = 'POST', path = '/mcp', token = TOKEN, contentType = 'application/json' }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (contentType) h['content-type'] = contentType;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(raw !== undefined ? raw : JSON.stringify(body));
  });
}

const rpcReq = (method, extra = {}) => ({ jsonrpc: '2.0', id: 1, method, ...extra });

// ---------------------------------------------------------------- pure helpers

test('Origin: absent is accepted (tunnel / server-to-server sends none)', () => {
  assert.equal(checkOrigin(undefined), null);
});

test('Origin: a present Origin with no allowlist is refused (DNS-rebinding defence)', () => {
  assert.ok(checkOrigin('http://evil.example'));
});

test('Origin: an explicitly allowlisted Origin is accepted', async () => {
  await withConfig({ mcp: { allowedOrigins: ['http://localhost:5173'] } }, () => {
    assert.equal(checkOrigin('http://localhost:5173'), null);
    assert.ok(checkOrigin('http://other.example'));
  });
});

test('negotiate: supported version with no body _meta is accepted', async () => {
  await withConfig({}, () => {
    assert.equal(negotiateProtocolVersion(V, {}).ok, true);
  });
});

test('negotiate: missing required header is 400 / -32020 HeaderMismatch', async () => {
  await withConfig({}, () => {
    const r = negotiateProtocolVersion(undefined, {});
    assert.equal(r.ok, false);
    assert.equal(r.problem.status, 400);
    assert.equal(r.problem.code, -32020);
  });
});

test('negotiate: header/body _meta version mismatch is 400 / -32020', async () => {
  await withConfig({}, () => {
    const r = negotiateProtocolVersion(V, { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } });
    assert.equal(r.ok, false);
    assert.equal(r.problem.code, -32020);
  });
});

test('negotiate: unknown version is rejected and advertises supported versions', async () => {
  await withConfig({}, () => {
    const r = negotiateProtocolVersion('1999-01-01', {});
    assert.equal(r.ok, false);
    assert.equal(r.problem.status, 400);
    assert.ok(Array.isArray(r.problem.data.supported) && r.problem.data.supported.length > 0);
  });
});

test('negotiate: matching header and body _meta is accepted', async () => {
  await withConfig({}, () => {
    const r = negotiateProtocolVersion(V, { _meta: { 'io.modelcontextprotocol/protocolVersion': V } });
    assert.equal(r.ok, true);
  });
});

// ---------------------------------------------------------------- live endpoint

test('endpoint: a notification is answered 202 Accepted with no body', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, {
        body: { jsonrpc: '2.0', method: 'notifications/initialized' },
        headers: { 'mcp-protocol-version': V }
      });
      assert.equal(res.status, 202);
      assert.equal(res.body, '');
    } finally { server.close(); }
  });
});

test('endpoint: a request is answered 200 application/json', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, {
        body: rpcReq('initialize', { params: {} }),
        headers: { 'mcp-protocol-version': V }
      });
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /application\/json/);
      assert.match(res.body, /nexora-opencode-bridge/);
    } finally { server.close(); }
  });
});

test('auth: a wrong bearer token is 401 and leaks no tool data', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, {
        body: rpcReq('tools/list'), token: 'wrong-token', headers: { 'mcp-protocol-version': V }
      });
      assert.equal(res.status, 401);
      assert.ok(!res.body.includes('opencode_submit_task'));
    } finally { server.close(); }
  });
});

test('auth: a missing bearer token is 401', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, { body: rpcReq('tools/list'), token: null, headers: { 'mcp-protocol-version': V } });
      assert.equal(res.status, 401);
    } finally { server.close(); }
  });
});

test('routing: an unknown path is 404', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, { body: rpcReq('ping'), path: '/not-mcp', headers: { 'mcp-protocol-version': V } });
      assert.equal(res.status, 404);
    } finally { server.close(); }
  });
});

test('routing: GET is 405 (this revision defines no GET stream)', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, { body: undefined, raw: '', method: 'GET', headers: { 'mcp-protocol-version': V } });
      assert.equal(res.status, 405);
    } finally { server.close(); }
  });
});

test('routing: DELETE is 405 (no protocol-level sessions in this revision)', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, { body: undefined, raw: '', method: 'DELETE', headers: { 'mcp-protocol-version': V } });
      assert.equal(res.status, 405);
    } finally { server.close(); }
  });
});

test('security: a disallowed Origin is 403 Forbidden', async () => {
  await withConfig({ mcp: { allowedOrigins: [] } }, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, {
        body: rpcReq('ping'), headers: { 'mcp-protocol-version': V, origin: 'http://evil.example' }
      });
      assert.equal(res.status, 403);
    } finally { server.close(); }
  });
});

test('security: an allowlisted Origin passes through to normal handling', async () => {
  await withConfig({ mcp: { allowedOrigins: ['http://localhost:5173'] } }, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, {
        body: rpcReq('ping'), headers: { 'mcp-protocol-version': V, origin: 'http://localhost:5173' }
      });
      assert.equal(res.status, 200);
    } finally { server.close(); }
  });
});

test('versioning: a missing MCP-Protocol-Version header is 400 HeaderMismatch', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, { body: rpcReq('ping') });
      assert.equal(res.status, 400);
      assert.match(res.body, /-32020/);
    } finally { server.close(); }
  });
});

test('versioning: an unsupported version is 400 and lists what is supported', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, { body: rpcReq('ping'), headers: { 'mcp-protocol-version': '1999-01-01' } });
      assert.equal(res.status, 400);
      assert.match(res.body, /supported/i);
    } finally { server.close(); }
  });
});

test('versioning: a header/body version mismatch is 400 HeaderMismatch', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, {
        body: rpcReq('ping', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } }),
        headers: { 'mcp-protocol-version': V }
      });
      assert.equal(res.status, 400);
      assert.match(res.body, /-32020/);
    } finally { server.close(); }
  });
});

test('errors: an unknown method is 404 with JSON-RPC -32601', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, { body: rpcReq('no/such/method'), headers: { 'mcp-protocol-version': V } });
      assert.equal(res.status, 404);
      assert.match(res.body, /-32601/);
    } finally { server.close(); }
  });
});

test('errors: malformed JSON is 400 with -32700', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, { raw: '{not json', headers: { 'mcp-protocol-version': V } });
      assert.equal(res.status, 400);
      assert.match(res.body, /-32700/);
    } finally { server.close(); }
  });
});

test('errors: an oversized body is 413 and is never parsed', async () => {
  await withConfig({ limits: { maxHttpBodyBytes: 1024 } }, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, {
        raw: JSON.stringify(rpcReq('ping', { pad: 'x'.repeat(5000) })),
        headers: { 'mcp-protocol-version': V }
      });
      assert.equal(res.status, 413);
    } finally { server.close(); }
  });
});

test('errors: a batched array is rejected (one JSON-RPC message per POST)', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, { raw: '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', headers: { 'mcp-protocol-version': V } });
      assert.equal(res.status, 400);
    } finally { server.close(); }
  });
});

test('errors: a JSON-RPC response posted by a client is rejected', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, { raw: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), headers: { 'mcp-protocol-version': V } });
      assert.equal(res.status, 400);
    } finally { server.close(); }
  });
});

test('errors: a non-JSON content-type is 415', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, { raw: '{}', method: 'POST', contentType: 'text/plain', headers: { 'mcp-protocol-version': V } });
      assert.equal(res.status, 415);
    } finally { server.close(); }
  });
});

test('lifecycle: initialize echoes a supported protocol version', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, {
        body: rpcReq('initialize', { params: { protocolVersion: V, capabilities: {}, clientInfo: { name: 'test' } } }),
        headers: { 'mcp-protocol-version': V }
      });
      assert.equal(res.status, 200);
      const payload = JSON.parse(res.body);
      assert.equal(payload.result.protocolVersion, V);
      assert.equal(payload.result.serverInfo.name, 'nexora-opencode-bridge');
      assert.ok(payload.result.capabilities.tools);
    } finally { server.close(); }
  });
});

test('lifecycle: initialize falls back to the newest supported version', async () => {
  await withConfig({ mcp: { supportedProtocolVersions: [V, '2025-06-18'] } }, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, {
        body: rpcReq('initialize', { params: { protocolVersion: '1999-01-01' } }),
        headers: { 'mcp-protocol-version': V }
      });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).result.protocolVersion, V);
    } finally { server.close(); }
  });
});

test('tools: tools/list is reachable over the conformant endpoint', async () => {
  await withConfig({}, async () => {
    const { server, port } = await startBridge();
    try {
      const res = await request(port, { body: rpcReq('tools/list'), headers: { 'mcp-protocol-version': V } });
      assert.equal(res.status, 200);
      const payload = JSON.parse(res.body);
      assert.equal(payload.result.tools.length, 9);
    } finally { server.close(); }
  });
});
