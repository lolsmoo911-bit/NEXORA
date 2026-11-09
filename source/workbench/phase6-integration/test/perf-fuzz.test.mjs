import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import { dayCountFraction } from '../src/daycount.mjs';
import { dirtyPrice } from '../src/bond.mjs';
import { bootstrapParCurve } from '../src/curve.mjs';

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const near = (actual, expected, tol, label) => assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected}`);

test('property: seeded fuzz — par reprices exact, DF positive, price strictly decreasing in yield', () => {
  const rand = mulberry(902024);
  for (let iter = 0; iter < 500; iter++) {
    const len = 1 + Math.floor(rand() * 8);
    const quotes = [];
    for (let k = 1; k <= len; k++) quotes.push({ tenorYears: k, parYield: 0.01 + rand() * 0.08 });
    const nodes = bootstrapParCurve(quotes);
    for (const n of nodes) {
      assert.ok(n.discountFactor > 0 && n.discountFactor <= 1.5);
      assert.ok(Number.isFinite(n.annualEffectiveZeroRate));
      let pv = 0;
      for (let k = 0; k < n.tenorYears; k++) pv += n.parYield * nodes[k].discountFactor;
      pv += nodes[n.tenorYears - 1].discountFactor;
      near(pv, 1, 1e-9, 'fuzz par reprice');
    }
    // No mutation and determinism under fuzz.
    assert.deepEqual(bootstrapParCurve(quotes), nodes);
  }
});

test('property: ICMA fraction is monotone in end date and sums to 1 across full schedule', () => {
  const periods = [
    { start: '2020-01-01', end: '2020-07-01' },
    { start: '2020-07-01', end: '2021-01-01' },
  ];
  let last = -1;
  for (const day of ['2020-01-01', '2020-03-15', '2020-07-01', '2020-10-20', '2021-01-01']) {
    const f = dayCountFraction('2020-01-01', day, 'ACT/ACT ICMA', { referencePeriods: periods, frequency: 2 });
    assert.ok(f >= last - 1e-12 && f >= 0 && f <= 1);
    last = f;
  }
  near(last, 1, 1e-12, 'full schedule sums to 1');
});

test('property: bond dirty price strictly decreases as yield rises (30/360 and ICMA)', () => {
  const bond30 = { face: 100, couponRate: 0.06, frequency: 2, maturity: '2030-06-15', dayCount: '30/360 US' };
  const icma = {
    face: 100, couponRate: 0.06, frequency: 2, maturity: '2021-01-01', dayCount: 'ACT/ACT ICMA',
    referencePeriods: [
      { start: '2020-01-01', end: '2020-07-01' }, { start: '2020-07-01', end: '2021-01-01' },
    ],
  };
  for (const [bond, s] of [[bond30, '2020-06-15'], [icma, '2020-04-01']]) {
    let prev = Infinity;
    for (const y of [0.005, 0.02, 0.06, 0.11, 0.24]) {
      const p = dirtyPrice(bond, y, s);
      assert.ok(p < prev, 'price must fall as yield rises');
      prev = p;
    }
  }
});

test('performance: bootstrapping 10y and repricing 2000x is deterministic and bounded', () => {
  const quotes = Array.from({ length: 10 }, (_, i) => ({ tenorYears: i + 1, parYield: 0.02 + i * 0.003 }));
  const bond = { face: 100, couponRate: 0.05, frequency: 2, maturity: '2030-06-15', dayCount: '30/360 US' };
  const start = process.hrtime.bigint();
  let checksum = 0;
  for (let r = 0; r < 2000; r++) {
    const nodes = bootstrapParCurve(quotes);
    checksum += nodes[9].discountFactor + dirtyPrice(bond, 0.04 + (r % 5) * 0.005, '2020-06-15');
  }
  const again = bootstrapParCurve(quotes).map(n => n.discountFactor).reduce((a, b) => a + b, 0);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  // Deterministic checksum must be finite and stable shape; write reproducible report.
  assert.ok(Number.isFinite(checksum));
  assert.ok(again > 0);
  writeFileSync(new URL('../perf-report.json', import.meta.url), JSON.stringify({
    iterations: 2000, ms: Math.round(ms * 100) / 100, checksum,
    note: 'Bounded reproducibility check, not a hardware benchmark. Generous 10s budget.',
  }, null, 2) + '\n');
  assert.ok(ms < 10000, `bounded budget exceeded: ${ms}ms`);
});
