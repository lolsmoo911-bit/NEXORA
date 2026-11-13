import test from 'node:test';
import assert from 'node:assert/strict';
import { EventIndexer } from '../src/event-indexer.mjs';

test('rejects malformed events and missing required payload fields', () => {
  const idx = new EventIndexer();
  assert.throws(() => idx.applyEvent(null), /event must be an object/);
  assert.throws(() => idx.applyEvent({ id: '', type: 'PriceUpdated', payload: {} }), /event\.id must be/);
  assert.throws(() => idx.applyEvent({ id: 'e1', type: 'TradeExecuted', payload: {} }), /TradeExecuted requires payload\.tradeId\/id/);
});

test('duplicate and replay preserve deterministic state', () => {
  const idx = new EventIndexer();
  const events = [
    { id: 'e1', type: 'PortfolioDeposit', payload: { accountId: 'u1', amount: 10 } },
    { id: 'e2', type: 'PortfolioPositionDelta', payload: { accountId: 'u1', instrument: 'X', delta: 2 } },
  ];
  idx.applyEvents([...events, events[0]]);
  const s1 = idx.getSnapshot();
  idx.rebuildFrom([...events, events[0]]);
  const s2 = idx.getSnapshot();
  assert.deepEqual(s1.state, s2.state);
  assert.equal(s2.state.portfolios['u1'].cash, 10);
  assert.equal(s2.state.portfolios['u1'].positions['X'], 2);
});
