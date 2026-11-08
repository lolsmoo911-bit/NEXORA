import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, ALLOWLIST } from '../server.mjs';
import { readFileSync } from 'node:fs';

async function withServer(upstream, fn, opts = {}) {
  const server = makeServer({ rpcTarget: upstream, ...opts });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(r => server.close(r)); }
}

const DEAD = 'http://127.0.0.1:65521';

test('allowlist is exactly the 8 truly required read-only methods', () => {
  assert.deepEqual([...ALLOWLIST].sort(), [
    'eth_blockNumber', 'eth_chainId', 'eth_gasPrice', 'eth_getBalance',
    'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'net_version',
  ].sort());
});

test('health shows disconnected with no fabricated chain identity when RPC is offline', async () => {
  await withServer(DEAD, async (base) => {
    const j = await fetch(base + '/api/health').then(r => r.json());
    assert.equal(j.status, 'ok'); assert.equal(j.readOnly, true);
    assert.equal(j.expectedChainId, 902024);
    assert.equal(j.rpc.connected, false);
    assert.equal(j.network.chainId, null);
    assert.match(j.network.label, /Disconnected/);
    assert.equal(j.wallets, 'not connected');
  });
});

test('health reports chain_id_mismatch when upstream is not 902024', async () => {
  const fake = await import('node:http').then(m => m.default.createServer((req, res) => {
    let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ const j=JSON.parse(b||'{}'); res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({jsonrpc:'2.0',id:j.id??1,result:j.method==='eth_chainId'?'0x1':'0x0'})); });
  }));
  await new Promise(r=>fake.listen(0,'127.0.0.1',r));
  try {
    await withServer(`http://127.0.0.1:${fake.address().port}`, async (base) => {
      const j = await fetch(base + '/api/health').then(r => r.json());
      assert.equal(j.rpc.connected, false);
      assert.equal(j.rpc.error, 'chain_id_mismatch');
      assert.equal(j.network.chainId, null);
      assert.match(j.network.label, /mismatch|Disconnected/i);
    });
  } finally { await new Promise(r=>fake.close(r)); }
});

test('UI demonstrates no wallet/signing/tx action: source has no wallet/send strings', async () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /NEXORA Scan/);
  assert.match(html, /No wallet/);
  assert.match(html, /signing/i);
  for (const bad of ['eth_sendRawTransaction', 'window.ethereum', 'metamask', 'sign(', 'personal_', 'connectWallet', 'sendTransaction']) {
    assert.ok(!html.toLowerCase().includes(bad.toLowerCase()), `UI must not reference ${bad}`);
  }
});

test('rejects write/admin/personal/debug/txpool/miner and unknown methods (403, no upstream contact needed)', async () => {
  await withServer(DEAD, async (base) => {
    for (const method of ['eth_sendRawTransaction', 'personal_sendTransaction', 'eth_sendTransaction', 'eth_sign', 'eth_accounts', 'admin_peers', 'debug_traceTransaction', 'txpool_status', 'miner_start', 'eth_call', 'eth_getCode', 'made_up_method']) {
      const r = await fetch(base + '/api/rpc', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params: [], id: 1 }),
      });
      assert.equal(r.status, 403, method);
      assert.equal((await r.json()).error, 'method_not_allowed');
    }
  });
});

test('validates JSON-RPC envelope: batch rejected, jsonrpc version, method, params, id', async () => {
  await withServer(DEAD, async (base) => {
    const post = async (body, ct='application/json') => fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': ct }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    let r = await post([{jsonrpc:'2.0',method:'eth_chainId',params:[],id:1}]);
    assert.equal(r.status, 400); assert.equal((await r.json()).error, 'batch_not_supported');
    r = await post({jsonrpc:'1.0',method:'eth_chainId',params:[],id:1});
    assert.equal(r.status, 400); assert.equal((await r.json()).error, 'invalid_jsonrpc_version');
    r = await post({jsonrpc:'2.0',method:123,params:[],id:1});
    assert.equal(r.status, 400);
    r = await post({jsonrpc:'2.0',method:'eth_chainId',params:{},id:1});
    assert.equal(r.status, 400); assert.equal((await r.json()).error, 'params_must_be_array');
    r = await post({jsonrpc:'2.0',method:'eth_chainId',params:[],id:{}});
    assert.equal(r.status, 400); assert.equal((await r.json()).error, 'invalid_id');
    r = await post('not-json{');
    assert.equal(r.status, 400); assert.equal((await r.json()).error, 'invalid_json');
  });
});

test('validates hash/address/block identifiers and strict param shapes', async () => {
  await withServer(DEAD, async (base) => {
    const cases = [
      ['eth_getTransactionByHash', ['0xZZZ'], 400],
      ['eth_getTransactionByHash', ['0x' + 'a'.repeat(63)], 400],
      ['eth_getBalance', ['not-an-address'], 400],
      ['eth_getBalance', ['0x' + 'b'.repeat(39)], 400],
      ['eth_getTransactionCount', ['0x12'], 400],
      ['eth_getBlockByNumber', ['bogus!!', true], 400],
      ['eth_getBlockByNumber', ['latest'], 400], // strict: requires [tag, boolean]
      ['eth_getBlockByNumber', ['latest', 'yes'], 400],
      ['eth_chainId', ['unexpected'], 400],
      ['eth_blockNumber', ['x'], 400],
    ];
    for (const [method, params, expected] of cases) {
      const r = await fetch(base + '/api/rpc', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      });
      assert.equal(r.status, expected, `${method} ${JSON.stringify(params)}`);
      if (expected === 400) assert.equal((await r.json()).error, 'invalid_params_for_method');
    }
  });
});

test('caps request bodies at 64KB (bounded read, no upstream contact)', async () => {
  await withServer(DEAD, async (base) => {
    const r = await fetch(base + '/api/rpc', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1, pad: 'x'.repeat(200 * 1024) }),
    });
    assert.equal(r.status, 413);
    assert.equal((await r.json()).error, 'request_too_large');
  });
});

test('rate limits repeated RPC requests (60/min)', async () => {
  await withServer(DEAD, async (base) => {
    let saw429 = false;
    for (let i = 0; i < 65; i++) {
      const r = await fetch(base + '/api/rpc', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
      });
      if (r.status === 429) { saw429 = true; break; }
      assert.equal(r.status, 502); // chain cannot be verified against dead upstream
    }
    assert.ok(saw429, 'expected a 429 within 65 requests');
  });
});

test('rejects proxy when chain cannot be verified as 902024 (dead upstream) and never fabricates result', async () => {
  await withServer(DEAD, async (base) => {
    const r = await fetch(base + '/api/rpc', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
    });
    assert.equal(r.status, 502);
    const j = await r.json();
    assert.equal(j.error, 'upstream_chain_not_verified');
    assert.match(j.network, /Disconnected|unavailable/);
    assert.ok(!('result' in j));
  });
});

test('rejects proxy on chain_id_mismatch', async () => {
  const fake = await import('node:http').then(m => m.default.createServer((req, res) => {
    let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ const j=JSON.parse(b||'{}'); res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({jsonrpc:'2.0',id:j.id??1,result:j.method==='eth_chainId'?'0x1':'0x0'})); });
  }));
  await new Promise(r=>fake.listen(0,'127.0.0.1',r));
  try {
    await withServer(`http://127.0.0.1:${fake.address().port}`, async (base) => {
      const r = await fetch(base + '/api/rpc', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
      });
      assert.equal(r.status, 502);
      assert.equal((await r.json()).error, 'chain_id_mismatch');
    });
  } finally { await new Promise(r=>fake.close(r)); }
});

test('caps upstream responses at 2MB during proxied method (after chain verified) and returns 502', async () => {
  const fake = await import('node:http').then(m => m.default.createServer((req, res) => {
    let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ const j=JSON.parse(b||'{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (j.method === 'eth_chainId') return res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 1, result: '0xdc388' }));
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 1, result: 'x'.repeat(3 * 1024 * 1024) }));
    });
  }));
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  try {
    await withServer(`http://127.0.0.1:${fake.address().port}`, async (base) => {
      const r = await fetch(base + '/api/rpc', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
      });
      assert.equal(r.status, 502);
      assert.equal((await r.json()).error, 'upstream_response_too_large');
    });
  } finally { await new Promise(r => fake.close(r)); }
});

test('proxies allowlisted reads only when chain verified as 902024 (fake upstream)', async () => {
  const fake = await import('node:http').then(m => m.default.createServer((req, res) => {
    let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ const j=JSON.parse(b||'{}');
      const result = j.method === 'eth_chainId' ? '0xdc388' : j.method === 'eth_blockNumber' ? '0x2a' : j.method === 'eth_getBlockByNumber' ? {number:j.params?.[0]} : j.method === 'eth_gasPrice' ? '0x3b9aca00' : j.method === 'net_version' ? '902024' : j.method === 'eth_getBalance' ? '0xde0b6b3a7640000' : j.method === 'eth_getTransactionCount' ? '0x1' : j.method === 'eth_getTransactionByHash' ? null : '0x0';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 1, result }));
    });
  }));
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  try {
    await withServer(`http://127.0.0.1:${fake.address().port}`, async (base) => {
      const health = await fetch(base + '/api/health').then(r=>r.json());
      assert.equal(health.rpc.connected, true); assert.equal(health.network.chainId, 902024);
      const post = async (method, params) => (await fetch(base + '/api/rpc', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method,params,id:1})})).json();
      assert.equal((await post('eth_blockNumber',[])).result, '0x2a');
      assert.equal((await post('eth_chainId',[])).result, '0xdc388');
      assert.equal((await post('eth_getBlockByNumber',['latest',true])).result.number, 'latest');
      assert.ok((await post('eth_getTransactionByHash',['0x'+'a'.repeat(64)])).hasOwnProperty('result'));
    });
  } finally { await new Promise(r => fake.close(r)); }
});

test('labels chain only from a live eth_chainId response (902024)', async () => {
  const fake = await import('node:http').then(m => m.default.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const j = JSON.parse(b || '{}');
      const result = j.method === 'eth_chainId' ? '0xdc388' : '0x0';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 1, result }));
    });
  }));
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  try {
    await withServer(`http://127.0.0.1:${fake.address().port}`, async (base) => {
      const j = await fetch(base + '/api/health').then(r => r.json());
      assert.equal(j.rpc.connected, true);
      assert.equal(j.network.chainId, 902024);
      assert.match(j.network.label, /NEXORA Testnet/);
    });
  } finally { await new Promise(r => fake.close(r)); }
});

test('refuses non-loopback rpcTarget for safety', () => {
  assert.throws(() => makeServer({ rpcTarget: 'http://8.8.8.8:8545' }), /loopback/);
});
