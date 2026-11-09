import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapParCurve } from '../../phase6-integration/src/curve.mjs';
import { dirtyPriceAtZSpread, solveZSpread, spreadDuration } from '../src/credit-spread.mjs';

const curve = bootstrapParCurve([{ tenorYears: 1, parYield: 0.04 }, { tenorYears: 2, parYield: 0.045 }]);
const bond = { face: 100, couponRate: 0.05, frequency: 1, maturity: '2028-01-01', dayCount: 'ACT/365F' };
const settlement = '2026-01-01';

test('z-spread solver round-trips a generated dirty price', () => {
  const price = dirtyPriceAtZSpread({ bond, settlement, curveNodes: curve, zSpread: 0.0125 });
  const solved = solveZSpread({ bond, settlement, curveNodes: curve, dirtyPrice: price });
  assert.ok(Math.abs(solved - 0.0125) < 1e-10);
});
test('spread duration is positive for a positive-cashflow bond', () => {
  const args = { bond, settlement, curveNodes: curve, zSpread: 0.01 };
  assert.ok(spreadDuration(args) > 0);
});
test('z-spread price falls monotonically as spread rises', () => {
  const a = dirtyPriceAtZSpread({ bond, settlement, curveNodes: curve, zSpread: 0.005 });
  const b = dirtyPriceAtZSpread({ bond, settlement, curveNodes: curve, zSpread: 0.02 });
  assert.ok(a > b);
});
test('rejects an impossible spread bracket and invalid curves', () => {
  assert.throws(() => solveZSpread({ bond, settlement, curveNodes: curve, dirtyPrice: 1e6 }), /outside/);
  assert.throws(() => dirtyPriceAtZSpread({ bond, settlement, curveNodes: [{ tenorYears: 1, discountFactor: -1 }], zSpread: 0 }), /positive/);
});
