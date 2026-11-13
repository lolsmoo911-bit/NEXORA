import test from 'node:test';
import assert from 'node:assert/strict';
import { PortfolioService } from '../src/portfolio-service.mjs';

test('deposit, withdraw and cash accounting', () => {
  const ps = new PortfolioService();
  ps.deposit('acc1', 1000);
  let snap = ps.withdraw('acc1', 250);
  assert.equal(snap.cash, 750);
  assert.equal(snap.equity, 750);
  assert.throws(() => ps.withdraw('acc1', 1000), /insufficient cash/);
});

test('buy fill creates long position and marks produce unrealized PnL', () => {
  const ps = new PortfolioService();
  ps.deposit('acc1', 10000);
  ps.applyFill({ accountId: 'acc1', instrument: 'XAUUSD', side: 'buy', quantity: 2, price: 100, fee: 2 });
  ps.setMark('XAUUSD', 110);
  const snap = ps.getAccountSnapshot('acc1');
  assert.equal(snap.cash, 9798);
  assert.equal(snap.positions.length, 1);
  assert.equal(snap.positions[0].quantity, 2);
  assert.equal(snap.positions[0].avgPrice, 100);
  assert.equal(snap.positions[0].unrealizedPnl, 20);
  assert.equal(snap.unrealizedPnl, 20);
  assert.equal(snap.equity, 10018); // cash + market value (9798 + 220)
  assert.equal(snap.grossExposure, 220);
});

test('partial sell realizes PnL and updates position', () => {
  const ps = new PortfolioService();
  ps.deposit('acc1', 10000);
  ps.applyFill({ accountId: 'acc1', instrument: 'XAUUSD', side: 'buy', quantity: 10, price: 100 });
  ps.applyFill({ accountId: 'acc1', instrument: 'XAUUSD', side: 'sell', quantity: 4, price: 120 });
  ps.setMark('XAUUSD', 115);
  const snap = ps.getAccountSnapshot('acc1');
  assert.equal(snap.cash, 9480);
  assert.equal(snap.realizedPnl, 80);
  assert.equal(snap.positions[0].quantity, 6);
  assert.equal(snap.positions[0].avgPrice, 100);
  assert.equal(snap.positions[0].unrealizedPnl, 90);
  assert.equal(snap.equity, 10170); // cash + market value (9480 + 690)
});

test('short sell and cover updates cash and realized PnL', () => {
  const ps = new PortfolioService();
  ps.deposit('acc1', 10000);
  ps.applyFill({ accountId: 'acc1', instrument: 'XAUUSD', side: 'sell', quantity: 5, price: 200 });
  ps.setMark('XAUUSD', 180);
  let snap = ps.getAccountSnapshot('acc1');
  assert.equal(snap.cash, 11000);
  assert.equal(snap.positions[0].quantity, -5);
  assert.equal(snap.positions[0].avgPrice, 200);
  assert.equal(snap.positions[0].unrealizedPnl, 100);

  ps.applyFill({ accountId: 'acc1', instrument: 'XAUUSD', side: 'buy', quantity: 2, price: 150 });
  snap = ps.getAccountSnapshot('acc1');
  assert.equal(snap.cash, 10700);
  assert.equal(snap.realizedPnl, 100);
  assert.equal(snap.positions[0].quantity, -3);
});

test('state snapshot is deterministic in structure', () => {
  const ps = new PortfolioService();
  ps.deposit('a', 100);
  ps.deposit('b', 50);
  ps.setMark('XAUUSD', 2000);
  const state = ps.getStateSnapshot();
  assert.deepEqual(state.accounts.map(a => a.accountId), ['a', 'b']);
  assert.deepEqual(state.marks, [{ instrument: 'XAUUSD', price: 2000 }]);
  assert.equal(state.accounts[0].history.length, 1);
});
