import http from 'node:http';

export const READ_ONLY_METHODS = Object.freeze([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_syncing',
  'eth_getBlockByNumber', 'eth_gasPrice', 'eth_getBalance',
  'eth_getTransactionCount', 'web3_clientVersion',
]);
const ALLOWED = new Set(READ_ONLY_METHODS);
export const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const validId = id => id === null || typeof id === 'string' ||
  (typeof id === 'number' && Number.isSafeInteger(id));
const sameId = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function validateMember(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not an object';
  if (value.jsonrpc !== '2.0') return 'jsonrpc must equal 2.0';
  if (typeof value.method !== 'string' || !value.method) return 'method must be a non-empty string';
  if (!Object.prototype.hasOwnProperty.call(value, 'id') || !validId(value.id)) return 'invalid or missing id';
  if (Object.hasOwn(value, 'params') &&
      !(Array.isArray(value.params) || (value.params !== null && typeof value.params === 'object'))) {
    return 'params must be an array or object';
  }
  return null;
}

function sendJson(res, status, payload, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function readBody(req, maxBytes) {
  const length = req.headers['content-length'];
  if (length !== undefined && Number(length) > maxBytes) {
    req.resume();
    throw Object.assign(new Error('payload too large'), { status: 413 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      req.resume();
      throw Object.assign(new Error('payload too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function callOrigin(upstreamUrl, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: controller.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_RESPONSE_BYTES) return { ok: false, status: 502, message: 'origin response too large' };
    let data;
    try { data = JSON.parse(buffer.toString('utf8')); }
    catch { return { ok: false, status: 502, message: 'origin returned non-JSON response' }; }
    if (!response.ok) return { ok: false, status: 502, message: 'origin returned HTTP ' + response.status };
    return { ok: true, data };
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      return { ok: false, status: 504, message: 'upstream timeout' };
    }
    return { ok: false, status: 502, message: 'upstream unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

export function createRpcGateway(options = {}) {
  const port = options.port ?? 3100;
  const upstreamUrl = options.upstreamUrl ?? process.env.NEXORA_EVM_RPC_URL ?? 'http://127.0.0.1:8545';
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? 10_000;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const corsOrigins = options.corsOrigins ?? [];
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('invalid gateway port');
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1) throw new RangeError('invalid upstream timeout');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_BODY_BYTES) throw new RangeError('invalid body limit');
  const originUrl = new URL(upstreamUrl);
  if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.username || originUrl.password || originUrl.hash) {
    throw new TypeError('upstream URL must be HTTP(S), without embedded credentials or fragment');
  }
  if (!Array.isArray(corsOrigins) || corsOrigins.some(value =>
    typeof value !== 'string' || !value || value === '*')) {
    throw new TypeError('CORS requires explicit non-wildcard origins');
  }
  const corsSet = new Set(corsOrigins);

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const vary = origin === undefined ? {} : { vary: 'Origin' };
    const cors = origin && corsSet.has(origin)
      ? { ...vary, 'access-control-allow-origin': origin } : vary;
    try {
      if (origin && !corsSet.has(origin)) return sendJson(res, 403, { error: 'origin not allowed' }, cors);
      if (req.method === 'OPTIONS') {
        if (req.url !== '/evm' || !origin || !corsSet.has(origin)) {
          return sendJson(res, 403, { error: 'CORS preflight not allowed' }, cors);
        }
        res.writeHead(204, {
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          ...cors, 'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'content-type', 'access-control-max-age': '600',
        });
        return res.end();
      }
      if (req.url === '/health') {
        if (req.method !== 'GET') {
          res.setHeader('allow', 'GET');
          return sendJson(res, 405, { error: 'method not allowed' }, cors);
        }
        return sendJson(res, 200, {
          ok: true, service: 'nexora-evm-rpc-edge', originChecked: false,
        }, cors);
      }
      if (req.url !== '/evm') return sendJson(res, 404, { error: 'not found' }, cors);
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return sendJson(res, 405, { error: 'method not allowed' }, cors);
      }

      let raw;
      try { raw = await readBody(req, maxBodyBytes); }
      catch (error) {
        const status = error.status === 413 ? 413 : 400;
        return sendJson(res, status, rpcError(null, status === 413 ? -32600 : -32700, error.message), cors);
      }
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { return sendJson(res, 400, rpcError(null, -32700, 'Parse error'), cors); }

      const batch = Array.isArray(parsed);
      if ((batch && parsed.length === 0) || (!batch && (!parsed || typeof parsed !== 'object'))) {
        return sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'), cors);
      }
      const requests = batch ? parsed : [parsed];
      const seen = new Set();
      const invalid = [];
      const allowed = [];
      const denied = [];
      requests.forEach((request, index) => {
        const reason = validateMember(request);
        if (reason) { invalid.push({ index, reason }); return; }
        const idKey = JSON.stringify(request.id);
        if (seen.has(idKey)) { invalid.push({ index, reason: 'duplicate id' }); return; }
        seen.add(idKey);
        const item = { index, request };
        (ALLOWED.has(request.method) ? allowed : denied).push(item);
      });
      if (!batch && invalid.length) {
        return sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'), cors);
      }
      if (batch && invalid.length) {
        const errors = requests.map((request, index) => {
          const bad = invalid.some(item => item.index === index);
          return bad ? rpcError(validId(request?.id) ? request.id : null, -32600, 'Invalid Request') : null;
        });
        return sendJson(res, 400, errors, cors);
      }
      if (!allowed.length) {
        const deniedResponses = requests.map(request => rpcError(request.id, -32601, 'Method not found'));
        return sendJson(res, 200, batch ? deniedResponses : deniedResponses[0], cors);
      }

      const originPayload = batch ? allowed.map(item => item.request) : allowed[0].request;
      const upstreamResult = await callOrigin(originUrl.toString(), originPayload, upstreamTimeoutMs);
      if (!upstreamResult.ok) {
        return sendJson(res, upstreamResult.status, rpcError(batch ? null : requests[0].id, -32603, upstreamResult.message), cors);
      }
      if (!batch) {
        if (!upstreamResult.data || typeof upstreamResult.data !== 'object' || Array.isArray(upstreamResult.data) ||
            !Object.hasOwn(upstreamResult.data, 'id') || !sameId(upstreamResult.data.id, requests[0].id)) {
          return sendJson(res, 502, rpcError(requests[0].id, -32603, 'Invalid origin response'), cors);
        }
        return sendJson(res, 200, upstreamResult.data, cors);
      }

      const originResponses = Array.isArray(upstreamResult.data) ? upstreamResult.data : [upstreamResult.data];
      const byId = new Map();
      for (const response of originResponses) {
        if (response && Object.hasOwn(response, 'id')) byId.set(JSON.stringify(response.id), response);
      }
      const merged = new Array(requests.length);
      for (const item of denied) merged[item.index] = rpcError(item.request.id, -32601, 'Method not found');
      for (const item of allowed) {
        merged[item.index] = byId.get(JSON.stringify(item.request.id)) ??
          rpcError(item.request.id, -32603, 'Origin omitted a batch response');
      }
      return sendJson(res, 200, merged, cors);
    } catch {
      return sendJson(res, 500, { error: 'internal gateway error' }, cors);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return {
    server, port,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      return server.address();
    },
    async close() {
      if (!server.listening) return;
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}
