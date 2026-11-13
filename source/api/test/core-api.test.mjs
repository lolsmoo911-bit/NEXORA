import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreApi } from '../src/core-api.mjs';

test('core API registers assets and updates/prices via feed normalization', () => {
  const api = createCoreApi();
  api.registerAsset({ assetId: 'aid:xau', symbol: 'XAU', assetClass: 'metal', lifecycleState: 'active', eventId: 'asset-xau' });
  const p = api.upsertPrice({ assetKey: 'XAUUSD', feed: { price: 235000000000, decimals: 8, isFresh: true, exists: true }, timestamp: 1000, sourceRef: 'mock' });
  assert.equal(p.value, 2350);
  assert.equal(api.getPrice('XAUUSD').value, 2350);
  const assets = api.listAssets();
  assert.equal(assets.length, 1);
  assert.equal(assets[0].symbol, 'XAU');
});

test('core API supports portfolio, trading, and valuation flow', () => {
  const api = createCoreApi();
  api.createAccount('alice');
  api.createAccount('bob');
  api.deposit('alice', 10000, { eventId: 'dep-a', timestamp: 1 });
  api.deposit('bob', 10000, { eventId: 'dep-b', timestamp: 1 });
  api.upsertPrice({ assetKey: 'XAUUSD', price: 100, timestamp: 2 });

  api.placeOrder({ id: 's1', instrument: 'XAUUSD', side: 'sell', type: 'limit', price: 100, quantity: 10, timestamp: 1, accountId: 'bob' });
  const res = api.placeOrder({ id: 'b1', instrument: 'XAUUSD', side: 'buy', type: 'limit', price: 100, quantity: 6, timestamp: 2, accountId: 'alice' });
  assert.equal(res.order.status, 'filled');
  assert.equal(res.trades.length, 1);
  const trade = res.trades[0];

  api.applyTradeFill({ accountId: 'alice', instrument: 'XAUUSD', side: 'buy', quantity: trade.quantity, price: trade.price, ref: trade.id, eventId: 'fill-a' });
  api.applyTradeFill({ accountId: 'bob', instrument: 'XAUUSD', side: 'sell', quantity: trade.quantity, price: trade.price, ref: trade.id, eventId: 'fill-b' });

  const pa = api.getPortfolio('alice');
  const pb = api.getPortfolio('bob');
  assert.equal(pa.cash, 9400);
  assert.equal(pa.positions[0].quantity, 6);
  assert.equal(pb.cash, 10600);
  assert.equal(pb.positions[0].quantity, -6);

  const fxVal = api.value({ assetType: 'fx', spot: 1.1, baseRate: 0.03, quoteRate: 0.05, yearFraction: 1 });
  assert.equal(fxVal.kind, 'fx');
  assert.ok(fxVal.forward > 0);
});

test('core API snapshots include indexer, portfolios and prices', () => {
  const api = createCoreApi();
  api.createAccount('u1');
  api.deposit('u1', 100, { eventId: 'd1', timestamp: 1 });
  api.upsertPrice({ assetKey: 'EURUSD', price: 1.08, timestamp: 2 });
  const snap = api.snapshot();
  assert.ok(snap.indexer.state.portfolios['u1']);
  assert.equal(snap.portfolios.accounts.length, 1);
  assert.equal(snap.prices.length, 1);
  assert.equal(snap.prices[0].assetKey, 'EURUSD');
});
