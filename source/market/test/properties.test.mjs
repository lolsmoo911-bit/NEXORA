import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapParCurve } from '../src/curve.mjs';
import { dirtyPriceAtZSpread } from '../src/credit-spread.mjs';
import { fxTriangleDiagnostic, fxForwardRate } from '../src/fx.mjs';
import { cryptoScenarioQuantiles } from '../src/crypto-scenarios.mjs';
import { migrateModelState } from '../src/state-migration.mjs';

function rng(seed) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 0x100000000; }; }

test('seeded properties: curve factors positive and price decreases as spread rises', () => {
  const rand = rng(902024);
  for (let i = 0; i < 150; i++) {
    const q = 0.01 + rand() * 0.05;
    const curve = bootstrapParCurve([{ tenorYears: 1, parYield: q }, { tenorYears: 2, parYield: q + rand() * 0.01 }]);
    assert.ok(curve.every(n => n.discountFactor > 0));
    const bond = { face: 100, couponRate: 0.04, frequency: 1, maturity: '2028-01-01', dayCount: 'ACT/365F' };
    const args = { bond, settlement: '2026-01-01', curveNodes: curve };
    const low = dirtyPriceAtZSpread({ ...args, zSpread: 0.005 });
    const high = dirtyPriceAtZSpread({ ...args, zSpread: 0.03 });
    assert.ok(low > high);
  }
});
test('seeded FX carry and triangle identities hold', () => {
  const rand = rng(902025);
  for (let i = 0; i < 150; i++) {
    const spot = 0.5 + rand() * 2, br = rand() * 0.1, qr = rand() * 0.1, t = rand() * 5;
    const f = fxForwardRate({ spot, baseRate: br, quoteRate: qr, yearFraction: t });
    assert.ok(f > 0);
    const tri = fxTriangleDiagnostic({ base: 'EUR', cross: 'USD', quote: 'JPY', crossPerBase: 1.1, quotePerCross: 140, quotePerBase: 154, tolerance: 1e-10 });
    assert.equal(tri.consistent, true);
  }
});
test('seeded crypto prices positive and migrations stable', () => {
  const rand = rng(902026);
  for (let i = 0; i < 150; i++) {
    const r = cryptoScenarioQuantiles({ spot: 0.01 + rand() * 1000, annualVolatility: rand() * 2, years: rand() * 8 });
    assert.ok(r.every(x => x.price > 0));
    const state = JSON.stringify({ version: 1, scenarioId: `x${i}`, inputs: { value: i } });
    assert.equal(migrateModelState(state), migrateModelState(state));
  }
});
