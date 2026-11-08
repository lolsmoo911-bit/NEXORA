import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRpcGateway, READ_ONLY_METHODS, MAX_BODY_BYTES } from '../src/rpc-gateway.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function fixture(t, options = {}) {
  const seen = [];
  const responder = options.responder ?? ((req, res, parsed) => {
    const response = Array.isArray(parsed)
      ? parsed.map(item => ({ jsonrpc: '2.0', id: item.id, result: { echo: item.method } }))
      : { jsonrpc: '2.0', id: parsed.id, result: { echo: parsed.method } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      seen.push({ url: req.url, method: req.method, raw, parsed });
      responder(req, res, parsed);
    });
  });
  const upstreamAddress = await listen(upstream);
  const gateway = createRpcGateway({
    port: 0,
    upstreamUrl: `http://127.0.0.1:${upstreamAddress.port}/jsonrpc`,
    ...options.gateway,
  });
  await gateway.start();
  t.after(async () => {
    await gateway.close();
    await close(upstream);
  });
  return {
    seen,
    gateway,
    base: `http://127.0.0.1:${gateway.server.address().port}`,
  };
}

function rpc(method, id = 7, params) {
  const value = { jsonrpc: '2.0', id, method };
  if (params !== undefined) value.params = params;
  return value;
}

async function post(base, body, headers = {}) {
  return fetch(base + '/evm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('gateway binds loopback only and health does not assert origin health', async t => {
  const f = await fixture(t);
  const address = f.gateway.server.address();
  assert.equal(address.address, '127.0.0.1');
  assert.equal(address.port > 0, true);
  const response = await fetch(f.base + '/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: 'nexora-evm-rpc-edge',
    originChecked: false,
  });
  assert.equal(f.seen.length, 0);
});

test('the allowlist is exact and immutable', () => {
  assert.equal(Object.isFrozen(READ_ONLY_METHODS), true);
  assert.deepEqual([...READ_ONLY_METHODS], [
    'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_syncing',
    'eth_getBlockByNumber', 'eth_gasPrice', 'eth_getBalance',
    'eth_getTransactionCount', 'web3_clientVersion',
  ]);
});

test('every allowlisted method is forwarded and its response is returned', async t => {
  const f = await fixture(t);
  for (const [index, method] of READ_ONLY_METHODS.entries()) {
    const request = rpc(method, index + 1);
    const response = await post(f.base, request);
    assert.equal(response.status, 200, method);
    assert.deepEqual(await response.json(), {
      jsonrpc: '2.0',
      id: index + 1,
      result: { echo: method },
    });
    assert.equal(f.seen.at(-1).parsed.method, method);
    assert.equal(f.seen.at(-1).url, '/jsonrpc');
  }
  assert.equal(f.seen.length, READ_ONLY_METHODS.length);
});

test('write, signing, wallet, admin and debug methods are rejected before upstream', async t => {
  const f = await fixture(t);
  const blocked = [
    'eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign',
    'eth_signTransaction', 'personal_sign', 'personal_sendTransaction',
    'wallet_addEthereumChain', 'wallet_switchEthereumChain',
    'admin_addPeer', 'debug_traceTransaction', 'evm_mine',
    'anvil_setBalance', 'eth_getLogs', 'net_listening',
  ];
  for (const [index, method] of blocked.entries()) {
    const response = await post(f.base, rpc(method, index + 10));
    assert.equal(response.status, 200, method);
    const body = await response.json();
    assert.equal(body.error.code, -32601, method);
    assert.equal(body.id, index + 10, method);
  }
  assert.equal(f.seen.length, 0, 'blocked methods must never be forwarded');
});

test('null id is valid while a notification without id is rejected', async t => {
  const f = await fixture(t);
  const response = await post(f.base, rpc('eth_chainId', null));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, null);
  const notification = await post(f.base, { jsonrpc: '2.0', method: 'eth_chainId' });
  assert.equal(notification.status, 400);
  assert.equal((await notification.json()).error.code, -32600);
});

test('malformed JSON and invalid request shapes return HTTP 400', async t => {
  const f = await fixture(t);
  const badBodies = [
    '{',
    'null',
    '42',
    '{}',
    JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'eth_chainId' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId' }),
    JSON.stringify({ jsonrpc: '2.0', id: 1.5, method: 'eth_chainId' }),
    JSON.stringify({ jsonrpc: '2.0', id: 9007199254740992, method: 'eth_chainId' }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 42 }),
    JSON.stringify({ jsonrpc: '2.0', id: true, method: 'eth_chainId' }),
  ];
  for (const body of badBodies) {
    const response = await post(f.base, body);
    assert.equal(response.status, 400, body);
    const parsed = await response.json();
    assert.ok(parsed.error, body);
    assert.equal(parsed.error.code === -32700 || parsed.error.code === -32600, true);
  }
  assert.equal(f.seen.length, 0);
});

test('valid batch keeps request order and never forwards blocked members', async t => {
  const f = await fixture(t);
  const batch = [
    rpc('eth_blockNumber', 'block'),
    rpc('eth_sendRawTransaction', 'tx', ['0xdeadbeef']),
    rpc('eth_gasPrice', 33),
  ];
  const response = await post(f.base, batch);
  assert.equal(response.status, 200);
  const output = await response.json();
  assert.equal(output.length, 3);
  assert.deepEqual(output[0].result, { echo: 'eth_blockNumber' });
  assert.equal(output[1].error.code, -32601);
  assert.deepEqual(output[2].result, { echo: 'eth_gasPrice' });
  assert.deepEqual(f.seen[0].parsed.map(item => item.method), ['eth_blockNumber', 'eth_gasPrice']);
  assert.equal(f.seen[0].url, '/jsonrpc');
});

test('invalid batch members and duplicate IDs reject the batch', async t => {
  const f = await fixture(t);
  const invalid = await post(f.base, [rpc('eth_chainId', 1), { nope: true }]);
  assert.equal(invalid.status, 400);
  const dup = await post(f.base, [rpc('eth_chainId', 2), rpc('eth_blockNumber', 2)]);
  assert.equal(dup.status, 400);
  const empty = await post(f.base, []);
  assert.equal(empty.status, 400);
  assert.equal(f.seen.length, 0);
});

test('payload above one MiB is rejected with 413 before upstream', async t => {
  const f = await fixture(t);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getBlockByNumber',
    params: ['0x1', false, 'x'.repeat(MAX_BODY_BYTES + 32)],
  });
  assert.ok(Buffer.byteLength(body) > MAX_BODY_BYTES);
  const response = await post(f.base, body);
  assert.equal(response.status, 413);
  assert.equal(f.seen.length, 0);
});

test('only exact /evm POST and /health GET paths are served', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/evm')).status, 405);
  assert.equal((await post(f.base, rpc('eth_chainId'), {})).status, 200);
  assert.equal((await fetch(f.base + '/evm/')).status, 404);
  assert.equal((await post(f.base + '/anything', rpc('eth_chainId'))).status, 404);
  assert.equal((await fetch(f.base + '/health?verbose=1')).status, 404);
  assert.equal(f.seen.length, 1, 'only the exact POST /evm may reach upstream');
});

test('unavailable upstream returns 502 without crashing the gateway', async t => {
  const gateway = createRpcGateway({ port: 0, upstreamUrl: 'http://127.0.0.1:1' });
  await gateway.start();
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const response = await post(base, rpc('eth_chainId'));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.message, 'upstream unavailable');
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
});

test('upstream timeout returns 504', async t => {
  const f = await fixture(t, {
    gateway: { upstreamTimeoutMs: 25 },
    responder: (_req, res) => {
      setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'late' }));
        }
      }, 180);
    },
  });
  const response = await post(f.base, rpc('eth_chainId', 1));
  assert.equal(response.status, 504);
});

test('default CORS denies browser origins and never emits wildcard', async t => {
  const f = await fixture(t);
  const response = await post(f.base, rpc('eth_chainId'), { origin: 'https://evil.example' });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(f.seen.length, 0);
  assert.throws(() => createRpcGateway({ port: 0, corsOrigins: ['*'] }), /CORS/);
});

test('configured exact CORS origin is echoed and preflight is narrow', async t => {
  const f = await fixture(t, { gateway: { corsOrigins: ['https://console.example'] } });
  const response = await post(f.base, rpc('eth_chainId'), { origin: 'https://console.example' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://console.example');
  assert.match(response.headers.get('vary'), /Origin/);
  const preflight = await fetch(f.base + '/evm', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://console.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST');
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://console.example');
});

test('security headers are set and responses are not cached', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/health');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});
