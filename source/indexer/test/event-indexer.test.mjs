import test from 'node:test';
import assert from 'node:assert/strict';
import { EventIndexer } from '../src/event-indexer.mjs';

test('applies events and builds read models', () => {
  const idx = new EventIndexer();
  idx.applyEvents([
    { id: 'e1', type: 'AssetRegistered', timestamp: 1, payload: { assetId: 'aid:gold', assetClass: 'metal', symbol: 'XAU', lifecycleState: 'active' } },
    { id: 'e2', type: 'PriceUpdated', timestamp: 2, payload: { assetKey: 'XAUUSD', price: 2350, decimals: 2, isFresh: true } },
    { id: 'e3', type: 'OrderPlaced', timestamp: 3, payload: { orderId: 'o1', instrument: 'XAUUSD', side: 'buy', status: 'open' } },
    { id: 'e4', type: 'TradeExecuted', timestamp: 4, payload: { tradeId: 't1', instrument: 'XAUUSD', price: 2350, quantity: 1 } },
    { id: 'e5', type: 'PortfolioDeposit', timestamp: 5, payload: { accountId: 'u1', amount: 1000 } },
    { id: 'e6', type: 'PortfolioPositionDelta', timestamp: 6, payload: { accountId: 'u1', instrument: 'XAUUSD', delta: 1 } },
  ]);
  const snap = idx.getSnapshot();
  assert.equal(snap.state.assets['aid:gold'].symbol, 'XAU');
  assert.equal(snap.state.prices['XAUUSD'].price, 2350);
  assert.equal(snap.state.orders['o1'].status, 'open');
  assert.equal(snap.state.trades['t1'].price, 2350);
  assert.equal(snap.state.portfolios['u1'].cash, 1000);
  assert.equal(snap.state.portfolios['u1'].positions['XAUUSD'], 1);
  assert.equal(snap.stats.applied, 6);
});

test('is idempotent for duplicate event ids', () => {
  const idx = new EventIndexer();
  const e = { id: 'dup-1', type: 'PortfolioDeposit', payload: { accountId: 'u1', amount: 50 } };
  idx.applyEvent(e);
  idx.applyEvent(e);
  idx.applyEvent({ ...e, payload: { accountId: 'u1', amount: 999 } });
  const snap = idx.getSnapshot();
  assert.equal(snap.state.portfolios['u1'].cash, 50);
  assert.equal(snap.stats.duplicates, 2);
  assert.equal(snap.stats.applied, 1);
});

test('rebuildFrom replays deterministically and resets state', () => {
  const idx = new EventIndexer();
  const events = [
    { id: 'e1', type: 'AssetRegistered', payload: { assetId: 'a1', symbol: 'AAA' } },
    { id: 'e2', type: 'PriceUpdated', payload: { assetKey: 'AAAUSD', price: 10 } },
    { id: 'e3', type: 'PortfolioDeposit', payload: { accountId: 'u1', amount: 100 } },
  ];
  idx.applyEvents(events);
  idx.applyEvent({ id: 'temp', type: 'PortfolioDeposit', payload: { accountId: 'u1', amount: 999 } });
  const rebuilt = idx.rebuildFrom(events).length;
  const snap = idx.getSnapshot();
  assert.equal(rebuilt, 3);
  assert.equal(snap.state.portfolios['u1'].cash, 100);
  assert.deepEqual(snap.state.events, ['e1', 'e2', 'e3']);
});

test('handles state changes and unknown events safely', () => {
  const idx = new EventIndexer();
  idx.applyEvents([
    { id: 'e1', type: 'AssetRegistered', payload: { assetId: 'a1', lifecycleState: 'draft' } },
    { id: 'e2', type: 'AssetStateChanged', payload: { assetId: 'a1', lifecycleState: 'active' } },
    { id: 'e3', type: 'OrderPlaced', payload: { orderId: 'o1', status: 'open' } },
    { id: 'e4', type: 'OrderCancelled', payload: { orderId: 'o1' } },
    { id: 'e5', type: 'UnknownThing', payload: { x: 1 } },
  ]);
  const snap = idx.getSnapshot();
  assert.equal(snap.state.assets['a1'].lifecycleState, 'active');
  assert.equal(snap.state.orders['o1'].status, 'cancelled');
  assert.equal(snap.stats.ignored, 1);
  assert.equal(snap.stats.applied, 4);
});
