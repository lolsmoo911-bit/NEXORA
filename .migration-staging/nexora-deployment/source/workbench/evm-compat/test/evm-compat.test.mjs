import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  txFeeWei, clearsBaseFee, estimateBudgetWei, formatAnex, parseAnex, hexToBigInt,
  MIN_GAS_PRICE_WEI_PER_GAS, CONFIGURED_GAS_PRICE_WEI_PER_GAS, WEI_PER_ANEX,
} from '../src/gas.mjs';
import { MATRIX, matrixSummary, validateMatrix, EXPECTED_EVM_CHAIN_ID_DEC } from '../src/matrix.mjs';
import { rpcCall, probeNode, assertNEXORAvIdentity } from '../src/probe.mjs';

test('constants match nexora-devnet.json fees', () => {
  assert.equal(MIN_GAS_PRICE_WEI_PER_GAS, 1000000000n); // 1 gwei floor
  assert.equal(CONFIGURED_GAS_PRICE_WEI_PER_GAS, 2000000000n); // 2 gwei
  assert.equal(WEI_PER_ANEX, 1000000000000000000n);
});

test('txFeeWei: 21000 gas at 2 gwei = 0.000042 anex', () => {
  const fee = txFeeWei({ gasUsed: 21000, gasPriceWeiPerGas: 2000000000n });
  assert.equal(fee, 42000000000000n);
  assert.equal(formatAnex(fee), '0.000042000000000000');
});

test('clearsBaseFee: configured 2 gwei clears 1 gwei floor and 1.1 gwei observed', () => {
  assert.equal(clearsBaseFee({ configuredWeiPerGas: 2000000000n, baseFeeWeiPerGas: 1000000000n }).clears, true);
  // 0x430e2340 = 1125000000 (~1.125 gwei) observed in STATUS.md
  const obs = hexToBigInt('0x430e2340');
  assert.equal(obs, 1125000000n);
  assert.equal(clearsBaseFee({ configuredWeiPerGas: 2000000000n, baseFeeWeiPerGas: obs }).clears, true);
  const no = clearsBaseFee({ configuredWeiPerGas: 0n, baseFeeWeiPerGas: 1000000000n });
  assert.equal(no.clears, false);
  assert.equal(no.marginWeiPerGas, -1000000000n);
});

test('estimateBudgetWei + parseAnex round trip', () => {
  const b = estimateBudgetWei({ gasLimit: 10000000n, gasPriceWeiPerGas: 2000000000n });
  assert.equal(b, 20000000000000000n); // 0.02 anex
  assert.equal(parseAnex('1.23'), 1230000000000000000n);
  assert.equal(formatAnex(1000000000000000000n), '1.000000000000000000');
  assert.equal(parseAnex(formatAnex(123456789n)), 123456789n);
});

test('gas domain rejection', () => {
  assert.throws(() => txFeeWei({ gasUsed: -1, gasPriceWeiPerGas: 1n }), /gasUsed/);
  assert.throws(() => estimateBudgetWei({ gasLimit: 0n, gasPriceWeiPerGas: 1n }), /gasLimit/);
  assert.throws(() => parseAnex('1.2345678901234567890'), /decimal anex/);
  assert.throws(() => hexToBigInt('bc'), /0x-prefixed/);
});

test('matrix invariants', () => {
  assert.equal(validateMatrix(), true);
  const s = matrixSummary();
  assert.equal(s.total, 12);
  assert.equal(s['CI-VERIFIED'], 10);
  assert.equal(s['NOT-RUN'], 2);
  assert.equal(EXPECTED_EVM_CHAIN_ID_DEC, 902024);
});

test('probe reports disconnected without a node', async () => {
  // Closed port on loopback: must report disconnected, never a fabricated chain.
  const probe = await probeNode('http://127.0.0.1:9', {});
  assert.equal(probe.connected, false);
  assert.equal(probe.chainIdDec, null);
  assert.throws(() => assertNEXORAvIdentity(probe), /disconnected/);
});

test('rpcCall + assertNEXORAvIdentity against a loopback fake upstream', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const j = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type': 'application/json' });
      if (j.method === 'eth_chainId') res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xdc388' }));
      else if (j.method === 'net_version') res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '902024' }));
      else if (j.method === 'eth_blockNumber') res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' }));
      else if (j.method === 'eth_gasPrice') res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x430e2340' }));
      else if (j.method === 'eth_estimateGas') res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x5208' }));
      else res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  try {
    const probe = await probeNode(url, { from: '0x0000000000000000000000000000000000000000', to: '0x0000000000000000000000000000000000000001' });
    assert.equal(probe.connected, true);
    assert.equal(probe.chainIdDec, 902024);
    assert.equal(probe.chainIdHex, '0xdc388');
    assert.equal(probe.netVersion, '902024');
    assert.equal(probe.blockNumber, '0x10');
    assert.equal(probe.gasPriceWei, '0x430e2340');
    assert.equal(probe.estimateGas, '0x5208');
    assert.equal(assertNEXORAvIdentity(probe), true);
    const bad = await rpcCall(url, 'eth_noSuchMethod', []);
    assert.equal(bad.ok, false);
  } finally {
    server.close();
  }
});
