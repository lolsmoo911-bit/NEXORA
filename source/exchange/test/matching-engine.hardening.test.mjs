import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchingEngine } from '../src/matching-engine.mjs';

test('rejects non-finite and malformed order inputs', () => {
  const eng = new MatchingEngine({ now: () => 1 });
  assert.throws(() => eng.placeOrder({ id: 'a', side: 'buy', type: 'limit', price: Infinity, quantity: 1, instrument: 'X' }), /price must be/);
  assert.throws(() => eng.placeOrder({ id: 'b', side: 'buy', type: 'limit', price: 1, quantity: NaN, instrument: 'X' }), /quantity must be/);
  assert.throws(() => eng.placeOrder({ id: '', side: 'buy', type: 'limit', price: 1, quantity: 1, instrument: 'X' }), /id must be/);
  assert.throws(() => eng.placeOrder({ id: 'c', side: 'buy', type: 'limit', price: 1, quantity: 1, instrument: '' }), /instrument must be/);
});

test('does not match across instruments and preserves book isolation', () => {
  const eng = new MatchingEngine({ now: () => 1 });
  eng.placeOrder({ id: 's1', side: 'sell', type: 'limit', price: 100, quantity: 1, instrument: 'A', timestamp: 1 });
  const res = eng.placeOrder({ id: 'b1', side: 'buy', type: 'limit', price: 100, quantity: 1, instrument: 'B', timestamp: 2 });
  assert.equal(res.trades.length, 0);
  assert.equal(eng.getBook('A').asks.length, 1);
  assert.equal(eng.getBook('B').bids.length, 1);
});
