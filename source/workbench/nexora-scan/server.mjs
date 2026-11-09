import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ALLOWLIST = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_getTransactionByHash', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_gasPrice', 'net_version',
]);

const EXPECTED_CHAIN_ID = 902024;
const EXPECTED_CHAIN_HEX = '0xdc388';
const ADDR = /^0x[a-fA-F0-9]{40}$/;
const HASH = /^0x[a-fA-F0-9]{64}$/;
const BLOCK = /^(latest|earliest|pending|0x[0-9a-fA-F]+|\d+)$/;
const MAX_BODY = 64 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const UPSTREAM_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 1500;
const CHAIN_CACHE_TTL_MS = 5000;

function isLoopbackUrl(u) {
  try {
    const x = new URL(u);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(x.hostname);
  } catch { return false; }
}

function validParams(method, params) {
  try {
    if (method === 'eth_getTransactionByHash') return params.length === 1 && typeof params[0] === 'string' && HASH.test(params[0]);
    if (method === 'eth_getBalance') return params.length >= 1 && typeof params[0] === 'string' && ADDR.test(params[0]) && (params.length === 1 || (params.length === 2 && typeof params[1] === 'string' && BLOCK.test(params[1])));
    if (method === 'eth_getTransactionCount') return params.length >= 1 && typeof params[0] === 'string' && ADDR.test(params[0]) && (params.length === 1 || (params.length === 2 && typeof params[1] === 'string' && BLOCK.test(params[1])));
    if (method === 'eth_getBlockByNumber') return params.length === 2 && typeof params[0] === 'string' && BLOCK.test(params[0]) && typeof params[1] === 'boolean';
    if (method === 'eth_chainId' || method === 'eth_blockNumber' || method === 'eth_gasPrice' || method === 'net_version') return params.length === 0;
    return false;
  } catch { return false; }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

function clientIp(req) { return req.socket.remoteAddress || 'unknown'; }

async function readBodyLimited(req, max) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.removeAllListeners('error');
      req.removeAllListeners('aborted');
      // do not destroy() on size limit; resume to drain so client can receive response
      try { req.resume(); } catch {}
      err ? reject(err) : resolve(val);
    };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > max) return finish(Object.assign(new Error('too_large'), { code: 413 }));
      chunks.push(c);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks)));
    req.on('error', (e) => finish(e));
    req.on('aborted', () => finish(new Error('aborted')));
  });
}

async function readResponseTextLimited(res, max, signal) {
  // Node 24 fetch returns Web ReadableStream body
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    if (t.length > max) throw Object.assign(new Error('upstream_response_too_large'), { code: 502 });
    return t;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let size = 0;
  try {
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error('timeout'), { code: 504 });
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        try { await reader.cancel(); } catch {}
        throw Object.assign(new Error('upstream_response_too_large'), { code: 502 });
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return out;
}

async function fetchJsonRpc(target, payload, timeoutMs, maxResponse) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(target, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: ctrl.signal,
    });
    const text = await readResponseTextLimited(r, maxResponse, ctrl.signal);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw Object.assign(new Error('upstream_not_json'), { code: 502 }); }
    return { status: r.status, parsed, text };
  } catch (e) {
    if (e?.name === 'AbortError') throw Object.assign(new Error('upstream_timeout'), { code: 504 });
    if (e?.code) throw e;
    throw Object.assign(new Error('upstream_unreachable'), { code: 502, cause: e?.message });
  } finally {
    clearTimeout(timer);
  }
}

function parseChainIdHex(result) {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) return null;
  try { return Number(BigInt(result)); } catch { return null; }
}

function makeServer({ rpcTarget = process.env.NEXORA_RPC_TARGET || 'http://127.0.0.1:8545', now = () => Date.now(), expectedChainId = EXPECTED_CHAIN_ID } = {}) {
  if (!isLoopbackUrl(rpcTarget)) {
    throw new Error('rpcTarget must be loopback (127.0.0.1/localhost/::1) for read-only safety');
  }
  const hits = new Map();
  let chainCache = { at: 0, value: null };

  function rateOk(ip, t) {
    const arr = (hits.get(ip) || []).filter(x => t - x < RATE_WINDOW_MS);
    if (arr.length >= RATE_MAX) return false;
    arr.push(t);
    hits.set(ip, arr);
    return true;
  }

  async function probeChainId(force = false) {
    const t = now();
    if (!force && chainCache.value && (t - chainCache.at) < CHAIN_CACHE_TTL_MS) return chainCache.value;
    let value;
    try {
      const { parsed } = await fetchJsonRpc(rpcTarget, { jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }, PROBE_TIMEOUT_MS, MAX_RESPONSE);
      const dec = parseChainIdHex(parsed?.result);
      if (dec === expectedChainId) {
        value = {
          connected: true, chainIdHex: parsed.result, chainId: dec,
          chainLabel: `NEXORA Testnet (eip155:${dec}, verified via live eth_chainId)`,
        };
      } else if (dec !== null) {
        value = { connected: false, error: 'chain_id_mismatch', chainIdHex: parsed.result, chainId: dec, expectedChainId };
      } else {
        value = { connected: false, error: 'chain_identity_unavailable' };
      }
    } catch (e) {
      value = { connected: false, error: e?.message === 'upstream_timeout' ? 'upstream_timeout' : 'upstream_unreachable' };
    }
    chainCache = { at: t, value };
    return value;
  }

  async function ensureExpectedChain() {
    const p = await probeChainId();
    if (p.connected && p.chainId === expectedChainId) return p;
    return null;
  }

  function validateEnvelope(payload) {
    if (Array.isArray(payload)) return { ok: false, code: 400, error: 'batch_not_supported' };
    if (!payload || typeof payload !== 'object') return { ok: false, code: 400, error: 'invalid_jsonrpc_envelope' };
    if (payload.jsonrpc !== '2.0') return { ok: false, code: 400, error: 'invalid_jsonrpc_version' };
    if (typeof payload.method !== 'string') return { ok: false, code: 400, error: 'invalid_method' };
    if (!('params' in payload)) payload.params = [];
    if (!Array.isArray(payload.params)) return { ok: false, code: 400, error: 'params_must_be_array' };
    if ('id' in payload) {
      const id = payload.id;
      const okId = id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
      if (!okId) return { ok: false, code: 400, error: 'invalid_id' };
    }
    return { ok: true };
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && u.pathname === '/') {
        const file = fileURLToPath(new URL('./public/index.html', import.meta.url));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(readFileSync(file, 'utf8'));
        return;
      }
      if (req.method === 'GET' && u.pathname === '/api/health') {
        const probe = await probeChainId();
        const connectedExpected = probe.connected && probe.chainId === expectedChainId;
        return json(res, 200, {
          status: 'ok',
          site: 'nexora-scan',
          readOnly: true,
          wallets: 'not connected',
          signing: 'disabled',
          expectedChainId,
          rpc: probe,
          network: connectedExpected
            ? { chainId: probe.chainId, chainIdHex: probe.chainIdHex, label: probe.chainLabel }
            : { chainId: null, chainIdHex: null, label: probe.error === 'chain_id_mismatch' ? `Disconnected — chain ID mismatch (expected eip155:${expectedChainId})` : 'Disconnected — network identity unavailable' },
        });
      }
      if (req.method === 'POST' && u.pathname === '/api/rpc') {
        const ip = clientIp(req);
        if (!rateOk(ip, now())) return json(res, 429, { error: 'rate_limited' });
        let raw;
        try { raw = await readBodyLimited(req, MAX_BODY); }
        catch (e) { return json(res, e?.code === 413 ? 413 : 400, { error: e?.code === 413 ? 'request_too_large' : 'invalid_request_body' }); }
        let payload;
        try { payload = JSON.parse(raw.toString('utf8')); }
        catch { return json(res, 400, { error: 'invalid_json' }); }
        const env = validateEnvelope(payload);
        if (!env.ok) return json(res, env.code, { error: env.error });
        const method = payload.method;
        // Reject write/admin/personal/debug/txpool/miner and all non-allowlisted methods
        if (!ALLOWLIST.has(method)) {
          return json(res, 403, { error: 'method_not_allowed', method, allowed: [...ALLOWLIST] });
        }
        if (!validParams(method, payload.params)) return json(res, 400, { error: 'invalid_params_for_method', method });
        const chain = await ensureExpectedChain();
        if (!chain) {
          const probe = await probeChainId();
          return json(res, 502, {
            error: probe.error === 'chain_id_mismatch' ? 'chain_id_mismatch' : 'upstream_chain_not_verified',
            expectedChainId,
            network: probe.error === 'chain_id_mismatch' ? `Chain ID mismatch (expected eip155:${expectedChainId})` : 'Disconnected — network identity unavailable',
          });
        }
        try {
          const upstream = await fetchJsonRpc(rpcTarget, { jsonrpc: '2.0', method, params: payload.params, id: ('id' in payload ? payload.id : 1) }, UPSTREAM_TIMEOUT_MS, MAX_RESPONSE);
          res.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(upstream.text);
        } catch (e) {
          return json(res, e?.code === 502 && e?.message === 'upstream_response_too_large' ? 502 : 502, { error: e?.message || 'upstream_unreachable' });
        }
        return;
      }
      return json(res, 404, { error: 'not_found', path: u.pathname });
    } catch (e) {
      if (!res.headersSent) return json(res, 500, { error: 'internal_error' });
    }
  });

  server.ALLOWLIST = ALLOWLIST;
  server.EXPECTED_CHAIN_ID = expectedChainId;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 18081);
  const host = process.env.HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.error('[nexora-scan] refusing to bind non-loopback host');
    process.exit(2);
  }
  makeServer().listen(port, host, () => {
    console.log(`[nexora-scan] listening on ${host}:${port} (loopback only, expected chain ${EXPECTED_CHAIN_ID})`);
  });
}

export { makeServer };
