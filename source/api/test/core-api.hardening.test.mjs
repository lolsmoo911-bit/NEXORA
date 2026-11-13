import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreApi } from '../src/core-api.mjs';

test('core API rejects invalid asset and price inputs', () => {
  const api = createCoreApi();
  assert.throws(() => api.registerAsset({ symbol: 'X' }), /asset\.assetId\/aid\/id is required/);
  assert.throws(() => api.upsertPrice({ assetKey: 'XAUUSD', price: 0 }), /price must be/);
  assert.throws(() => api.upsertPrice({ assetKey: 'XAUUSD', feed: { exists: false } }), /feed does not exist/);
});

test('core API does not mutate portfolio on rejected trade fill', () => {
  const api = createCoreApi();
  api.createAccount('u1');
  api.deposit('u1', 10, { eventId: 'd1', timestamp: 1 });
  assert.throws(() => api.applyTradeFill({ accountId: 'u1', instrument: 'XAUUSD', side: 'buy', quantity: 1, price: 20 }), /insufficient cash/);
  const snap = api.getPortfolio('u1');
  assert.equal(snap.cash, 10);
  assert.equal(snap.positions.length, 0);
});
