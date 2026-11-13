import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapParCurve } from '../src/curve.mjs';
import { dirtyPriceAtZSpread } from '../src/credit-spread.mjs';
import {
  normalizeOracleFeed,
  priceAsset,
  valueBondScenario,
  valueCrypto,
  valueFx,
  valueMarketScenario,
} from '../src/pricing-service.mjs';

const bond = { face: 100, couponRate: 0.05, frequency: 1, maturity: '2028-01-01', dayCount: 'ACT/365F' };
const settlement = '2026-01-01';
const parQuotes = [{ tenorYears: 1, parYield: 0.04 }, { tenorYears: 2, parYield: 0.045 }];

test('normalizeOracleFeed scales price and enforces freshness/existence', () => {
  const feed = { price: 235000000000n ? 235000000000 : 235000000000, decimals: 8, updatedAt: 1000, isFresh: true, exists: true, sourceRef: 'mock:xau' };
  // use numeric-safe value
  const normalized = normalizeOracleFeed({ price: 235000000000, decimals: 8, updatedAt: 1000, isFresh: true, exists: true, sourceRef: 'mock:xau' });
  assert.equal(normalized.value, 2350);
  assert.equal(normalized.decimals, 8);
  assert.equal(normalized.isFresh, true);

  assert.throws(() => normalizeOracleFeed({ price: 1, decimals: 8, isFresh: false, exists: true }, { requireFresh: true }), /stale/);
  assert.throws(() => normalizeOracleFeed({ price: 1, decimals: 8, isFresh: true, exists: false }, { requireExists: true }), /does not exist/);
  assert.equal(normalizeOracleFeed({ exists: false }, { requireExists: false }), null);
});

test('valueBondScenario bootstraps curve and solves z-spread from dirty price', () => {
  const curve = bootstrapParCurve(parQuotes);
  const dirtyPrice = dirtyPriceAtZSpread({ bond, settlement, curveNodes: curve, zSpread: 0.01 });
  const out = valueBondScenario({ instrument: bond, settlement, parQuotes, dirtyPrice });
  assert.equal(out.kind, 'bond');
  assert.equal(out.curveNodes.length, 2);
  assert.ok(Math.abs(out.creditSpread.zSpread - 0.01) < 1e-9);
  assert.ok(Math.abs(out.creditSpread.repricedDirtyPrice - dirtyPrice) < 1e-8);
});

test('valueFx supports oracle-normalized spot, forward and triangle diagnostics', () => {
  const out = valueFx({
    spotFeed: { price: 108000000, decimals: 8, isFresh: true, exists: true },
    baseRate: 0.03,
    quoteRate: 0.05,
    yearFraction: 1,
    triangle: { base: 'EUR', cross: 'USD', quote: 'JPY', crossPerBase: 1.08, quotePerCross: 150, quotePerBase: 162 },
  });
  assert.equal(out.kind, 'fx');
  assert.equal(out.spot, 1.08);
  assert.ok(out.forward > 0);
  assert.equal(out.triangle.consistent, true);
});

test('valueCrypto supports oracle-normalized spot and deterministic shocks', () => {
  const out = valueCrypto({
    spotFeed: { price: 10000000000, decimals: 8, isFresh: true, exists: true },
    shocks: [-0.1, 0, 0.1],
  });
  assert.equal(out.kind, 'crypto');
  assert.equal(out.mode, 'shocks');
  assert.equal(out.spot, 100);
  assert.deepEqual(out.scenarios.map((s) => s.scenarioPrice), [90, 100, 110.00000000000001]);
});

test('priceAsset dispatches and valueMarketScenario composes simulation with oracle spot', () => {
  const curve = bootstrapParCurve(parQuotes);
  const dirtyPrice = dirtyPriceAtZSpread({ bond, settlement, curveNodes: curve, zSpread: 0.01 });
  const scenario = {
    parQuotes,
    bond: { instrument: bond, settlement, dirtyPrice },
    fx: { spotFeed: { price: 110000000, decimals: 8, isFresh: true, exists: true }, baseRate: 0.03, quoteRate: 0.05, yearFraction: 1 },
    crypto: { spotFeed: { price: 10000000000, decimals: 8, isFresh: true, exists: true }, annualVolatility: 0.7, years: 1 },
  };
  const viaDispatcher = priceAsset({ assetType: 'market-scenario', ...scenario });
  const direct = valueMarketScenario(scenario);
  assert.equal(viaDispatcher.schemaVersion, 1);
  assert.deepEqual(viaDispatcher.outputs.crypto, direct.outputs.crypto);
  assert.equal(viaDispatcher.outputs.fxForward, direct.outputs.fxForward);
  assert.throws(() => priceAsset({ assetType: 'unknown' }), /unsupported assetType/);
});
