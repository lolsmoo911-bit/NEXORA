import test from 'node:test';
import assert from 'node:assert/strict';
import { runMarketSimulation } from '../src/simulation.mjs';
import { dirtyPriceAtZSpread } from '../src/credit-spread.mjs';
import { bootstrapParCurve } from '../src/curve.mjs';

const bond = { face: 100, couponRate: 0.05, frequency: 1, maturity: '2028-01-01', dayCount: 'ACT/365F' };
const settlement = '2026-01-01';
const curve = bootstrapParCurve([{ tenorYears: 1, parYield: 0.04 }, { tenorYears: 2, parYield: 0.045 }]);
const dirtyPrice = dirtyPriceAtZSpread({ bond, settlement, curveNodes: curve, zSpread: 0.01 });
const scenario = {
  parQuotes: [{ tenorYears: 1, parYield: 0.04 }, { tenorYears: 2, parYield: 0.045 }],
  bond: { instrument: bond, settlement, dirtyPrice },
  fx: { spot: 1.1, baseRate: 0.03, quoteRate: 0.05, yearFraction: 1, triangle: { base: 'EUR', cross: 'USD', quote: 'JPY', crossPerBase: 1.08, quotePerCross: 150, quotePerBase: 162 } },
  crypto: { spot: 100, annualVolatility: 0.7, years: 1 },
};

test('market simulation composes curve, credit, FX and crypto deterministically', () => {
  const before = structuredClone(scenario);
  const result = runMarketSimulation(scenario);
  assert.ok(Math.abs(result.outputs.creditSpread.zSpread - 0.01) < 1e-9);
  assert.equal(result.outputs.fxTriangle.consistent, true);
  assert.ok(result.outputs.crypto.every(x => x.price > 0));
  assert.deepEqual(scenario, before);
  assert.deepEqual(runMarketSimulation(scenario), result);
});
test('market simulation rejects invalid schema inputs', () => {
  assert.throws(() => runMarketSimulation({}), /bond/);
});
