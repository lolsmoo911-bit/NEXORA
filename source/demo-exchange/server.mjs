import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCoreApi } from '../api/src/core-api.mjs';
import { createAssetIssuanceWorkflow } from '../workflows/src/asset-issuance.mjs';
import { createLifecycleController } from '../controls/src/lifecycle-controls.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

const api = createCoreApi();
const issuance = createAssetIssuanceWorkflow({ coreApi: api });
const lifecycle = createLifecycleController();

function seed() {
  issuance.issueAsset({
    issuanceId: 'iss-xau', assetId: 'aid:xau', symbol: 'XAUUSD', name: 'Simulated Gold', assetClass: 'metal',
  }, { identity: { aid: 'aid:xau' }, representation: { tokenRef: 'tok-xau' } });
  issuance.issueAsset({
    issuanceId: 'iss-btc', assetId: 'aid:btc', symbol: 'BTCUSD', name: 'Simulated Bitcoin', assetClass: 'crypto',
  }, { identity: { aid: 'aid:btc' }, representation: { tokenRef: 'tok-btc' } });
  issuance.issueAsset({
    issuanceId: 'iss-eur', assetId: 'aid:eur', symbol: 'EURUSD', name: 'Simulated Euro', assetClass: 'fiat',
  }, { identity: { aid: 'aid:eur' }, representation: { tokenRef: 'tok-eur' } });
  for (const id of ['asset:aid:xau', 'asset:aid:btc', 'asset:aid:eur']) {
    lifecycle.registerEntity(id, { kind: 'asset', state: 'draft' });
    lifecycle.transition(id, 'active', { actorId: 'system', reason: 'seed' });
  }
  api.createAccount('alice'); api.createAccount('bob'); api.createAccount('market-maker');
  api.deposit('alice', 100000, { eventId: 'seed-dep-a', timestamp: Date.now() });
  api.deposit('bob', 100000, { eventId: 'seed-dep-b', timestamp: Date.now() });
  api.deposit('market-maker', 250000, { eventId: 'seed-dep-mm', timestamp: Date.now() });
  api.upsertPrice({ assetKey: 'XAUUSD', price: 2350, timestamp: Date.now(), sourceRef: 'seed' });
  api.upsertPrice({ assetKey: 'BTCUSD', price: 65000, timestamp: Date.now(), sourceRef: 'seed' });
  api.upsertPrice({ assetKey: 'EURUSD', price: 1.08, timestamp: Date.now(), sourceRef: 'seed' });
  // seed some liquidity
  api.placeOrder({ id: 'mm-s1', instrument: 'XAUUSD', side: 'sell', type: 'limit', price: 2352, quantity: 5, timestamp: Date.now(), accountId: 'market-maker' });
  api.placeOrder({ id: 'mm-s2', instrument: 'XAUUSD', side: 'sell', type: 'limit', price: 2355, quantity: 8, timestamp: Date.now(), accountId: 'market-maker' });
  api.placeOrder({ id: 'mm-b1', instrument: 'XAUUSD', side: 'buy', type: 'limit', price: 2348, quantity: 5, timestamp: Date.now(), accountId: 'market-maker' });
  api.placeOrder({ id: 'mm-b2', instrument: 'XAUUSD', side: 'buy', type: 'limit', price: 2345, quantity: 8, timestamp: Date.now(), accountId: 'market-maker' });
  api.placeOrder({ id: 'mm-bs1', instrument: 'BTCUSD', side: 'sell', type: 'limit', price: 65100, quantity: 0.5, timestamp: Date.now(), accountId: 'market-maker' });
  api.placeOrder({ id: 'mm-bb1', instrument: 'BTCUSD', side: 'buy', type: 'limit', price: 64900, quantity: 0.5, timestamp: Date.now(), accountId: 'market-maker' });
}
seed();

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('invalid JSON body'); }
}

function applyTradesToAccounts(trades, takerOrder) {
  // If taker order specifies accountId, apply fills for taker and try to apply for maker if known
  const takerAccount = takerOrder?.accountId;
  for (const tr of trades) {
    const takerIsBuy = tr.buyOrderId === takerOrder?.id;
    const takerSide = takerIsBuy ? 'buy' : 'sell';
    const makerSide = takerIsBuy ? 'sell' : 'buy';
    if (takerAccount) {
      try { api.applyTradeFill({ accountId: takerAccount, instrument: tr.instrument, side: takerSide, quantity: tr.quantity, price: tr.price, ref: tr.id, eventId: `fill-${takerAccount}-${tr.id}` }); } catch {}
    }
    // best-effort: maker accounts not tracked on resting orders in engine; skip automatic credit/debit for unknown maker
  }
}

function markets() {
  const assets = api.listAssets();
  return assets.map(a => {
    const symbol = a.symbol || a.assetId;
    const p = api.getPrice(symbol);
    return { symbol, name: a.name, assetClass: a.assetClass, lifecycleState: a.lifecycleState, price: p?.value ?? null, updatedAt: p?.timestamp ?? null };
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname, searchParams } = url;

    // Static UI
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(publicDir, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (pathname === '/api/health') return json(res, 200, { ok: true, mode: 'local-sim-exchange' });
    if (req.method === 'GET' && pathname === '/api/markets') return json(res, 200, { markets: markets() });
    if (req.method === 'GET' && pathname === '/api/assets') return json(res, 200, { assets: api.listAssets() });
    if (req.method === 'GET' && pathname === '/api/orderbook') {
      const instrument = searchParams.get('instrument') || 'XAUUSD';
      return json(res, 200, { orderbook: api.getOrderBook(instrument, { depth: 20 }) });
    }
    if (req.method === 'GET' && pathname === '/api/trades') {
      const instrument = searchParams.get('instrument') || undefined;
      return json(res, 200, { trades: api.getTrades(instrument).slice(-50).reverse() });
    }
    if (req.method === 'GET' && pathname === '/api/portfolio') {
      const account = searchParams.get('account') || 'alice';
      return json(res, 200, { portfolio: api.getPortfolio(account) });
    }
    if (req.method === 'GET' && pathname === '/api/snapshot') return json(res, 200, api.snapshot());

    if (req.method === 'POST' && pathname === '/api/deposit') {
      const body = await readBody(req);
      const out = api.deposit(body.account || 'alice', Number(body.amount), { eventId: `dep-${Date.now()}`, timestamp: Date.now() });
      return json(res, 200, { portfolio: out });
    }
    if (req.method === 'POST' && pathname === '/api/price') {
      const body = await readBody(req);
      const out = api.upsertPrice({ assetKey: body.instrument, price: Number(body.price), timestamp: Date.now(), sourceRef: 'manual-sim' });
      return json(res, 200, { price: out });
    }
    if (req.method === 'POST' && pathname === '/api/orders') {
      const body = await readBody(req);
      const order = {
        id: body.id || `ord-${Date.now()}-${Math.random().toString(16).slice(2,6)}`,
        instrument: body.instrument || 'XAUUSD',
        side: body.side,
        type: 'limit',
        price: Number(body.price),
        quantity: Number(body.quantity),
        timestamp: Date.now(),
        accountId: body.account || 'alice',
      };
      const result = api.placeOrder(order);
      applyTradesToAccounts(result.trades, result.order);
      // update mark to last trade if any
      if (result.trades.length) api.upsertPrice({ assetKey: order.instrument, price: result.trades[result.trades.length - 1].price, timestamp: Date.now(), sourceRef: 'trade' });
      return json(res, 200, result);
    }
    if (req.method === 'POST' && pathname === '/api/orders/cancel') {
      const body = await readBody(req);
      const out = api.cancelOrder(body.orderId);
      return json(res, 200, { order: out });
    }

    return json(res, 404, { error: 'not_found' });
  } catch (err) {
    return json(res, 400, { error: err?.message || String(err) });
  }
});

export { server, api, markets };

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const PORT = Number(process.env.PORT || 4173);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`NEXORA demo exchange (local simulation) running at http://127.0.0.1:${PORT}`);
  });
}
