import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchingEngine, createMatchingEngine } from '../src/matching-engine.mjs';

function place(engine, o) {
  return engine.placeOrder({ instrument: 'XAUUSD', ...o });
}

test('places resting limit orders and sorts book by price-time priority', () => {
  const eng = createMatchingEngine({ now: () => 1000 });
  place(eng, { id: 'b1', side: 'buy', type: 'limit', price: 100, quantity: 1, timestamp: 1 });
  place(eng, { id: 'b2', side: 'buy', type: 'limit', price: 101, quantity: 1, timestamp: 2 });
  place(eng, { id: 'b3', side: 'buy', type: 'limit', price: 101, quantity: 1, timestamp: 3 });
  place(eng, { id: 'a1', side: 'sell', type: 'limit', price: 105, quantity: 1, timestamp: 1 });
  place(eng, { id: 'a2', side: 'sell', type: 'limit', price: 104, quantity: 1, timestamp: 2 });
  const book = eng.getBook('XAUUSD');
  assert.deepEqual(book.bids.map(x => x.orderId), ['b2', 'b3', 'b1']);
  assert.deepEqual(book.asks.map(x => x.orderId), ['a2', 'a1']);
});

test('matches buy order against best asks at maker price with partial fills', () => {
  const eng = new MatchingEngine({ now: () => 2000 });
  place(eng, { id: 's1', side: 'sell', type: 'limit', price: 100, quantity: 2, timestamp: 1 });
  place(eng, { id: 's2', side: 'sell', type: 'limit', price: 101, quantity: 2, timestamp: 2 });
  const res = place(eng, { id: 'b1', side: 'buy', type: 'limit', price: 101, quantity: 3, timestamp: 3 });

  assert.equal(res.order.status, 'filled');
  assert.equal(res.trades.length, 2);
  assert.deepEqual(res.trades.map(t => ({ price: t.price, quantity: t.quantity, makerOrderId: t.makerOrderId })), [
    { price: 100, quantity: 2, makerOrderId: 's1' },
    { price: 101, quantity: 1, makerOrderId: 's2' },
  ]);
  assert.equal(eng.getOrder('s1').status, 'filled');
  assert.equal(eng.getOrder('s2').status, 'partially_filled');
  assert.equal(eng.getOrder('s2').remaining, 1);
  assert.deepEqual(eng.getBook('XAUUSD').asks.map(x => x.orderId), ['s2']);
});

test('matches sell order against best bids and leaves resting remainder', () => {
  const eng = new MatchingEngine({ now: () => 3000 });
  place(eng, { id: 'b1', side: 'buy', type: 'limit', price: 100, quantity: 1, timestamp: 1 });
  place(eng, { id: 'b2', side: 'buy', type: 'limit', price: 102, quantity: 1, timestamp: 2 });
  const res = place(eng, { id: 's1', side: 'sell', type: 'limit', price: 101, quantity: 2, timestamp: 3 });

  assert.equal(res.order.status, 'partially_filled');
  assert.equal(res.order.remaining, 1);
  assert.equal(res.trades.length, 1);
  assert.equal(res.trades[0].price, 102);
  assert.equal(res.trades[0].makerOrderId, 'b2');
  assert.deepEqual(eng.getBook('XAUUSD').bids.map(x => x.orderId), ['b1']);
  assert.deepEqual(eng.getBook('XAUUSD').asks.map(x => x.orderId), ['s1']);
});

test('cancel removes resting order and rejects invalid cancels', () => {
  const eng = new MatchingEngine({ now: () => 4000 });
  place(eng, { id: 'b1', side: 'buy', type: 'limit', price: 100, quantity: 1, timestamp: 1 });
  const cancelled = eng.cancelOrder('b1');
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(eng.getBook('XAUUSD').bids, []);
  assert.throws(() => eng.cancelOrder('b1'), /cannot cancel/);
  assert.throws(() => eng.cancelOrder('missing'), /unknown order id/);
});

test('rejects invalid inputs and duplicate ids', () => {
  const eng = new MatchingEngine({ now: () => 5000 });
  assert.throws(() => place(eng, { id: 'x', side: 'buy', type: 'market', price: 1, quantity: 1 }), /only limit orders/);
  assert.throws(() => place(eng, { id: 'x', side: 'hold', type: 'limit', price: 1, quantity: 1 }), /side must be/);
  assert.throws(() => place(eng, { id: 'x', side: 'buy', type: 'limit', price: 0, quantity: 1 }), /price must be/);
  assert.throws(() => place(eng, { id: 'x', side: 'buy', type: 'limit', price: 1, quantity: 0 }), /quantity must be/);
  place(eng, { id: 'ok', side: 'buy', type: 'limit', price: 1, quantity: 1 });
  assert.throws(() => place(eng, { id: 'ok', side: 'buy', type: 'limit', price: 1, quantity: 1 }), /duplicate order id/);
});
