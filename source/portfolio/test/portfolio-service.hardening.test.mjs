import test from 'node:test';
import assert from 'node:assert/strict';
import { PortfolioService } from '../src/portfolio-service.mjs';

test('rejects invalid monetary operations and negative/NaN inputs', () => {
  const ps = new PortfolioService();
  assert.throws(() => ps.deposit('u1', 0), /amount must be > 0/);
  assert.throws(() => ps.deposit('u1', -1), /amount must be > 0/);
  assert.throws(() => ps.withdraw('u1', 1), /insufficient cash/);
  ps.deposit('u1', 10);
  assert.throws(() => ps.applyFill({ accountId: 'u1', instrument: 'X', side: 'buy', quantity: 1, price: NaN }), /price must be/);
});

test('prevents buying without sufficient cash', () => {
  const ps = new PortfolioService();
  ps.deposit('u1', 100);
  assert.throws(() => ps.applyFill({ accountId: 'u1', instrument: 'XAUUSD', side: 'buy', quantity: 2, price: 60 }), /insufficient cash/);
  const snap = ps.getAccountSnapshot('u1');
  assert.equal(snap.cash, 100);
  assert.equal(snap.positions.length, 0);
});
