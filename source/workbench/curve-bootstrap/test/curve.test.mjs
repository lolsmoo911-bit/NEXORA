/**
 * Par-yield curve bootstrap tests.
 *
 * Every expected value is hand-derived demand-side algebra for what the bootstrap
 * guarantees, not captured output: a par bond of tenor n must return exactly its face,
 * and where it does, the bootstrapped factors are whatever satisfies that identity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapParCurve } from '../src/curve.mjs';

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance,
    label + ': expected ~' + expected + ', received ' + actual);

const DF2_HAND = (100 - 6 * (1 / 1.05)) / 106;   // from 6*DF1 + 106*DF2 = 100
const DF3_HAND = (100 - 6.5 * ((1 / 1.05) + DF2_HAND)) / 106.5;

test('a one-year 5% par yield bootstraps to 1/1.05 and its own zero rate', () => {
  const nodes = bootstrapParCurve([{ tenorYears: 1, parYield: 0.05 }]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].tenorYears, 1);
  assert.equal(nodes[0].parYield, 0.05);
  near(nodes[0].discountFactor, 1 / 1.05, 1e-15, 'DF1');
  near(nodes[0].annualEffectiveZeroRate, 0.05, 1e-12, 'one-year zero equals its par yield');
});

test('a two-year 6% par yield bootstraps off the one-year factor', () => {
  const nodes = bootstrapParCurve([
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 2, parYield: 0.06 },
  ]);
  // Both hand routes must agree: the bootstrap identity and the par-price identity.
  near(nodes[1].discountFactor, (1 - 0.06 * (1 / 1.05)) / 1.06, 1e-14, 'bootstrap route');
  near(nodes[1].discountFactor, DF2_HAND, 1e-14, 'price route');
  near(nodes[1].annualEffectiveZeroRate, Math.pow(DF2_HAND, -1 / 2) - 1, 1e-12, 'zero2');
});

test('a three-node curve par-reprices every bond back to exactly 100', () => {
  const nodes = bootstrapParCurve([
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 2, parYield: 0.06 },
    { tenorYears: 3, parYield: 0.065 },
  ]);
  assert.equal(nodes.length, 3);
  // Each tenor reprices its OWN par bond to exactly face 100 using output factors only.
  near(nodes[0].discountFactor * 105, 100, 1e-12, '1y par bond');
  near(nodes[0].discountFactor * 6 + nodes[1].discountFactor * 106, 100, 1e-12, '2y par bond');
  near(nodes[0].discountFactor * 6.5 + nodes[1].discountFactor * 6.5
     + nodes[2].discountFactor * 106.5, 100, 1e-12, '3y par bond');
  // Hand-route values agree with the bootstrap outputs, and zeros are positive and finite.
  near(nodes[2].discountFactor, DF3_HAND, 1e-14, 'DF3');
  near(nodes[2].annualEffectiveZeroRate, Math.pow(DF3_HAND, -1 / 3) - 1, 1e-12, 'zero3');
  for (const n of nodes) {
    assert.ok(Number.isFinite(n.annualEffectiveZeroRate));
    assert.ok(n.discountFactor > 0 && n.discountFactor < 1);
  }
});

test('negative par yields above -1 are valid while factors stay positive', () => {
  const q1 = -0.01;
  const q2 = -0.005;
  const df1 = 1 / (1 + q1);
  const df2 = (1 - q2 * df1) / (1 + q2);
  const nodes = bootstrapParCurve([
    { tenorYears: 1, parYield: q1 },
    { tenorYears: 2, parYield: q2 },
  ]);
  near(nodes[0].discountFactor, df1, 1e-14, 'DF1 stays positive');
  near(nodes[1].discountFactor, df2, 1e-14, 'DF2 stays positive');
  near(nodes[1].annualEffectiveZeroRate, Math.pow(df2, -0.5) - 1, 1e-12, 'zero2');
  assert.ok(nodes.every(n => n.discountFactor > 0));
});

test('input shape and emptiness are rejected, never coerced', () => {
  assert.throws(() => bootstrapParCurve([]), /non-empty ordered array/);
  assert.throws(() => bootstrapParCurve('nope'), /non-empty ordered array/);
  assert.throws(() => bootstrapParCurve(null), /non-empty ordered array/);
  assert.throws(() => bootstrapParCurve(6), /non-empty ordered array/);
});

test('tenorYears sequence is enforced exactly: gaps, order, duplicates, integers', () => {
  // Gap: 1 then 3 (expected 2).
  assert.throws(() => bootstrapParCurve([
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 3, parYield: 0.06 },
  ]), /expected 2/);
  // Unsorted: 2 then 1 (expected 1 at index 0) - never silently sorted.
  assert.throws(() => bootstrapParCurve([
    { tenorYears: 2, parYield: 0.06 },
    { tenorYears: 1, parYield: 0.05 },
  ]), /expected 1/);
  // Duplicate: 1 then 1 (expected 2).
  assert.throws(() => bootstrapParCurve([
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 1, parYield: 0.05 },
  ]), /expected 2/);
  // Fractional tenor is not an integer.
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1.5, parYield: 0.05 }]), /integers/);
  // Tenor 0 / negative tenor are not positive integers.
  assert.throws(() => bootstrapParCurve([{ tenorYears: 0, parYield: 0.05 }]), /integers/);
});

test('parYield must be finite and strictly greater than -1', () => {
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1, parYield: -1 }]), /greater than -1/);
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1, parYield: -1.5 }]), /greater than -1/);
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1, parYield: NaN }]), /finite/);
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1, parYield: Infinity }]), /finite/);
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1, parYield: '0.05' }]), /numeric/);
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1 }]), /numeric/);
  assert.throws(() => bootstrapParCurve([{ parYield: 0.05 }]), /numeric/);
  assert.throws(() => bootstrapParCurve([null]), /numeric/);
});

test('a par quote that bootstraps to a non-positive discount factor is rejected', () => {
  // With DF1 = 1/1.05, a 110% two-year par coupon needs a negative or zero DF2.
  assert.throws(() => bootstrapParCurve([
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 2, parYield: 1.1 },
  ]), /tenor 2/);
});

test('inputs are not mutated and outputs are fresh objects', () => {
  const input = [
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 2, parYield: 0.06 },
    { tenorYears: 3, parYield: 0.065 },
  ];
  const snapshot = JSON.parse(JSON.stringify(input));
  const nodes = bootstrapParCurve(input);
  assert.deepEqual(input, snapshot, 'caller input must be untouched');
  assert.notStrictEqual(nodes[0], input[0], 'outputs are fresh nodes');
});

test('bootstrapping is deterministic for identical inputs', () => {
  const quotes = [
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 2, parYield: 0.06 },
    { tenorYears: 3, parYield: 0.065 },
  ];
  assert.deepEqual(bootstrapParCurve(quotes), bootstrapParCurve(quotes));
});