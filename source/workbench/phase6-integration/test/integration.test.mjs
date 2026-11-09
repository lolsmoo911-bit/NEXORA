import test from 'node:test';
import assert from 'node:assert/strict';

import { dayCountFraction } from '../src/daycount.mjs';
import { dirtyPrice, accruedInterest, cleanPrice, yieldFromDirtyPrice, schedule } from '../src/bond.mjs';
import { bootstrapParCurve } from '../src/curve.mjs';

const near = (actual, expected, tol = 1e-12, label = 'value') => {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected}`);
};

const ICMA_BOND = {
  face: 100, couponRate: 0.06, frequency: 2, maturity: '2021-01-01',
  dayCount: 'ACT/ACT ICMA',
  referencePeriods: [
    { start: '2020-01-01', end: '2020-07-01' },
    { start: '2020-07-01', end: '2021-01-01' },
  ],
};

test('e2e: curve-bootstrapped factors reprice every par bond to exactly face 100', () => {
  const nodes = bootstrapParCurve([
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 2, parYield: 0.06 },
    { tenorYears: 3, parYield: 0.065 },
  ]);
  for (const n of nodes) {
    let pv = 0;
    for (let k = 0; k < n.tenorYears; k++) pv += n.parYield * nodes[k].discountFactor;
    pv += nodes[n.tenorYears - 1].discountFactor;
    near(pv, 1, 1e-12, `par reprice ${n.tenorYears}y`);
    near(nodes[n.tenorYears - 1].annualEffectiveZeroRate,
      Math.pow(nodes[n.tenorYears - 1].discountFactor, -1 / n.tenorYears) - 1, 1e-12, 'zero formula');
  }
});

test('e2e: ICMA bond prices exactly at par on its coupon date and mid-period accrual is one quarter coupon', () => {
  near(dirtyPrice(ICMA_BOND, 0.06, '2020-07-01'), 100, 1e-9, 'coupon-date par');
  near(accruedInterest(ICMA_BOND, '2020-07-01'), 0, 1e-12, 'coupon-date accrual');
  // 2020-04-01 is half of 2020-01-01..2020-07-01 (91 of 182 days), so accrued = 1.5.
  near(accruedInterest(ICMA_BOND, '2020-04-01'), 1.5, 1e-12, 'mid-period accrual');
  const p = dirtyPrice(ICMA_BOND, 0.075, '2020-04-01');
  near(yieldFromDirtyPrice(ICMA_BOND, p, '2020-04-01'), 0.075, 1e-9, 'yield roundtrip');
  near(cleanPrice(ICMA_BOND, 0.075, '2020-04-01'), p - accruedInterest(ICMA_BOND, '2020-04-01'), 1e-12, 'clean = dirty - accrued');
});

test('contract: ICMA day-count fraction integrates with the bond module without mutation', () => {
  const bond = JSON.parse(JSON.stringify(ICMA_BOND));
  const snapshot = JSON.parse(JSON.stringify(bond));
  const frac = dayCountFraction('2020-01-01', '2021-01-01', 'ACT/ACT ICMA', {
    referencePeriods: bond.referencePeriods, frequency: bond.frequency,
  });
  near(frac, 1, 1e-12, 'full ICMA year');
  near(dirtyPrice(bond, 0.06, '2020-04-01'), dirtyPrice(bond, 0.06, '2020-04-01'), 0, 'deterministic');
  assert.deepEqual(bond, snapshot, 'bond input not mutated');
});

test('contract: curve bootstrap never mutates frozen input and returns fresh node objects', () => {
  const input = Object.freeze([
    Object.freeze({ tenorYears: 1, parYield: 0.05 }),
    Object.freeze({ tenorYears: 2, parYield: 0.06 }),
  ]);
  const nodes = bootstrapParCurve(input);
  assert.notStrictEqual(nodes[0], input[0]);
  assert.deepEqual(input.map(o => ({ ...o })), [
    { tenorYears: 1, parYield: 0.05 }, { tenorYears: 2, parYield: 0.06 },
  ]);
});

test('contract: bare ACT/ACT and unsupported conventions stay refused', () => {
  assert.throws(() => dayCountFraction('2020-01-01', '2021-01-01', 'ACT/ACT'), /not implemented/);
  assert.throws(() => dayCountFraction('2020-01-01', '2021-01-01', 'ACT/ACT ISDA'), /not implemented/);
  assert.throws(() => dayCountFraction('2020-01-01', '2021-01-01', 'ACT/ACT ICMA'), /referencePeriods/);
});

test('edge: schedule-derived ICMA periods reject stubs, gaps and mismatched maturity', () => {
  const gappy = { ...ICMA_BOND, referencePeriods: [
    { start: '2020-01-01', end: '2020-07-01' },
    { start: '2020-07-02', end: '2021-01-02' },
  ] };
  assert.throws(() => dirtyPrice(gappy, 0.06, '2020-04-01'));
  const wrongEnd = { ...ICMA_BOND, maturity: '2021-07-01' };
  assert.throws(() => dirtyPrice(wrongEnd, 0.06, '2020-04-01'));
});

test('regression: legacy 30/360 and ACT/365F fractions unchanged from base market', () => {
  near(dayCountFraction('2020-02-29', '2021-02-28', '30/360 US'), 361 / 360, 1e-12, '30/360 US');
  near(dayCountFraction('2020-02-29', '2021-02-28', '30E/360'), 359 / 360, 1e-12, '30E/360');
  near(dayCountFraction('2020-01-01', '2021-01-01', 'ACT/365F'), 366 / 365, 1e-12, 'ACT/365F');
});

test('state migration: serialized curve JSON round-trips through validation to identical nodes', () => {
  const quotes = [
    { tenorYears: 1, parYield: 0.05 }, { tenorYears: 2, parYield: 0.06 }, { tenorYears: 3, parYield: 0.065 },
  ];
  const before = bootstrapParCurve(quotes);
  const restored = bootstrapParCurve(JSON.parse(JSON.stringify(quotes)));
  assert.deepEqual(restored, before);
  // A migrated record missing a required field is rejected instead of coerced.
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1 }]), /numeric/);
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1, parYield: 0.05 }, { tenorYears: 3, parYield: 0.06 }]), /expected 2/);
});
