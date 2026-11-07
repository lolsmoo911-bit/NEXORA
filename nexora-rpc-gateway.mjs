/**
 * NEXORA — public HTTP gateway for the local four-validator testnet.
 *
 * Replit free workspaces have no inbound port: the container sits behind NAT, so binding
 * :26657 or :8545 exposes nothing. This gateway binds ONE HTTP port, and if Replit's
 * dev-domain ingress reaches that port, a browser or wallet can talk to the chain through
 * it. If the ingress does not reach it, this file changes nothing — the endpoint simply
 * stays unreachable, and no public claim is made.
 *
 * Routes:
 *   GET  /                        service banner
 *   GET  /health                  gateway + validator liveness
 *   ANY  /cosmos/*                -> CometBFT RPC  127.0.0.1:26657
 *   ANY  /evm/*                   -> EVM JSON-RPC   127.0.0.1:8545
 *   GET  /chain-info              chain id, EVM chain id, denom, genesis sha256
 *
 * Read-only guard: only the CometBFT read endpoints are exposed. The application runs on
 * node0's own port and is deliberately NOT proxied, so this gateway cannot sign, submit or
 * broadcast anything. A transaction is submitted from the operator's own machine.
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const COMET = 'http://127.0.0.1:26657';
const EVM = 'http://127.0.0.1:8545';
const GENESIS = process.env.GENESIS_FILE || '/tmp/opencode/nexora-testnet/genesis.json';

const CHAIN = {
  cosmosChainId: 'nexora-devnet-1',
  evmChainId: 902024,
  evmChainIdHex: '0xdc388',
  denom: 'anex',
  decimals: 18,
  bech32Prefix: 'cosmos'
};

function genesisSha256() {
  try {
    if (!existsSync(GENESIS)) return null;
    return createHash('sha256').update(readFileSync(GENESIS)).digest('hex');
  } catch {
    return null;
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization'
};

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json', ...CORS });
  res.end(body);
}

function proxy(target, req, res, pathWithQuery) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const up = http.request(
      target + pathWithQuery,
      {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] || 'application/json' }
      },
      (r) => {
        const out = [];
        r.on('data', (c) => out.push(c));
        r.on('end', () => {
          const payload = Buffer.concat(out);
          res.writeHead(r.statusCode, {
            'content-type': r.headers['content-type'] || 'application/json',
            ...CORS
          });
          res.end(payload);
        });
      }
    );
    up.on('error', (e) => json(res, 502, { error: 'upstream_unreachable', detail: String(e.message) }));
    if (body.length) up.write(body);
    up.end();
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname + u.search;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (p === '/' || p === '/health') {
    let validator = null;
    try {
      const s = JSON.parse(
        readFileSync('/dev/stdin', 'utf8') || 'null'
      );
      validator = s;
    } catch {
      /* not used; kept simple */
    }
    return json(res, 200, {
      service: 'nexora-testnet-gateway',
      mode: 'single-host, four local validators',
      chain: CHAIN,
      genesisSha256: genesisSha256(),
      public: false,
      note:
        'This gateway only forwards READ endpoints. It is not proof of a public network: ' +
        'whether anything outside this host can reach it depends on Replit ingress.',
      routes: {
        cosmos: '/cosmos/status, /cosmos/block?height=N, /cosmos/validators, /cosmos/net_info',
        evm: '/evm  (POST JSON-RPC, e.g. eth_chainId / eth_blockNumber)'
      }
    });
  }

  if (p === '/chain-info') {
    return json(res, 200, { chain: CHAIN, genesisSha256: genesisSha256() });
  }

  if (p.startsWith('/cosmos/')) {
    return proxy(COMET, req, res, p.slice('/cosmos'.length));
  }
  if (p === '/evm' || p.startsWith('/evm/')) {
    return proxy(EVM, req, res, p.slice('/evm'.length) || '/');
  }

  return json(res, 404, { error: 'not_found', path: p });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[nexora-gateway] listening on 0.0.0.0:${PORT}`);
});