import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDate, dayCountFraction, icmaDayCountFraction, assertSupportedConvention,
} from '../src/daycount.mjs';
import {
  dirtyPrice, cleanPrice, accruedInterest, yieldFromDirtyPrice, schedule,
} from '../src/bond.mjs';

const near = (actual, expected, tolerance = 1e-12, label = 'value') => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    label + ': expected ' + expected + ', received ' + actual);
};
const ANNUAL_LEAP = [
  { start: '2020-01-01', end: '2021-01-01' },
  { start: '2021-01-01', end: '2022-01-01' },
  { start: '2022-01-01', end: '2023-01-01' },
];

test('annual full period is one ICMA year', () => {
  near(icmaDayCountFraction([ANNUAL_LEAP[0]], 1, '2020-01-01', '2021-01-01'), 1);
});
test('annual partial period uses actual reference denominator', () => {
  near(icmaDayCountFraction([ANNUAL_LEAP[0]], 1, '2020-03-01', '2020-10-01'), 214 / 366);
});
test('multi-period interval includes separate actual denominators', () => {
  near(icmaDayCountFraction(ANNUAL_LEAP, 1, '2020-07-02', '2022-07-02'), 183 / 366 + 1 + 182 / 365);
});
test('semiannual full coupon periods each equal one half', () => {
  const p = [
    { start: '2020-01-01', end: '2020-07-01' },
    { start: '2020-07-01', end: '2021-01-01' },
  ];
  near(icmaDayCountFraction(p, 2, p[0].start, p[0].end), 0.5);
  near(icmaDayCountFraction(p, 2, p[1].start, p[1].end), 0.5);
  near(icmaDayCountFraction(p, 2, p[0].start, p[1].end), 1);
});
test('quarterly full periods each equal one quarter', () => {
  const p = [
    { start: '2020-01-01', end: '2020-04-01' },
    { start: '2020-04-01', end: '2020-07-01' },
    { start: '2020-07-01', end: '2020-10-01' },
    { start: '2020-10-01', end: '2021-01-01' },
  ];
  for (const period of p) near(icmaDayCountFraction([period], 4, period.start, period.end), 0.25);
  near(icmaDayCountFraction(p, 4, '2020-01-01', '2021-01-01'), 1);
});
test('EOM leap-February reference boundaries are preserved', () => {
  const p = [
    { start: '2019-08-31', end: '2020-02-29' },
    { start: '2020-02-29', end: '2020-08-31' },
  ];
  near(icmaDayCountFraction(p, 2, p[0].start, p[0].end), 0.5);
  near(icmaDayCountFraction(p, 2, p[1].start, p[1].end), 0.5);
});
test('missing or empty explicit schedule is rejected', () => {
  assert.throws(() => icmaDayCountFraction(undefined, 2, '2020-01-01', '2020-07-01'), /referencePeriods/);
  assert.throws(() => icmaDayCountFraction([], 2, '2020-01-01', '2020-07-01'), /referencePeriods/);
});
test('missing or unsupported frequency is rejected', () => {
  const p = [{ start: '2020-01-01', end: '2020-07-01' }];
  assert.throws(() => icmaDayCountFraction(p, undefined, '2020-01-01', '2020-07-01'), /frequency/);
  assert.throws(() => icmaDayCountFraction(p, 3, '2020-01-01', '2020-07-01'), /frequency/);
});
test('gaps, overlaps and zero-length reference periods are rejected', () => {
  assert.throws(() => icmaDayCountFraction([
    { start: '2020-01-01', end: '2020-07-01' },
    { start: '2020-07-02', end: '2021-01-02' },
  ], 2, '2020-01-01', '2021-01-02'), /gap/);
  assert.throws(() => icmaDayCountFraction([
    { start: '2020-01-01', end: '2020-07-02' },
    { start: '2020-07-01', end: '2021-01-01' },
  ], 2, '2020-01-01', '2021-01-01'), /overlap/);
  assert.throws(() => icmaDayCountFraction([
    { start: '2020-01-01', end: '2020-01-01' },
  ], 2, '2020-01-01', '2020-01-01'), /zero length/);
});
test('reversed, uncovered and irregular stub intervals are rejected', () => {
  const p = [{ start: '2020-01-01', end: '2020-07-01' }];
  assert.throws(() => icmaDayCountFraction(p, 2, '2020-07-01', '2020-01-01'), /end precedes start/);
  assert.throws(() => icmaDayCountFraction(p, 2, '2019-12-31', '2020-01-01'), /outside/);
  assert.throws(() => icmaDayCountFraction([
    { start: '2020-01-15', end: '2020-06-15' },
  ], 2, '2020-01-15', '2020-06-15'), /irregular/);
});
test('bond ICMA accrual, dirty price, clean price and yield roundtrip share schedule basis', () => {
  const b = {
    face: 100, couponRate: 0.06, frequency: 2, maturity: '2021-01-01',
    dayCount: 'ACT/ACT ICMA',
    referencePeriods: [
      { start: '2020-01-01', end: '2020-07-01' },
      { start: '2020-07-01', end: '2021-01-01' },
    ],
  };
  const settlement = '2020-04-01';
  near(accruedInterest(b, settlement), 1.5);
  const expectedDirty = 3 / Math.pow(1.03, 0.5) + 103 / Math.pow(1.03, 1.5);
  near(dirtyPrice(b, 0.06, settlement), expectedDirty);
  near(cleanPrice(b, 0.06, settlement), expectedDirty - 1.5);
  near(yieldFromDirtyPrice(b, expectedDirty, settlement), 0.06, 1e-10);
});
test('coupon-date settlement accrues zero and par price remains 100', () => {
  const b = {
    face: 100, couponRate: 0.06, frequency: 2, maturity: '2021-01-01',
    dayCount: 'ACT/ACT ICMA',
    referencePeriods: [
      { start: '2020-01-01', end: '2020-07-01' },
      { start: '2020-07-01', end: '2021-01-01' },
    ],
  };
  near(accruedInterest(b, '2020-07-01'), 0);
  near(dirtyPrice(b, 0.06, '2020-07-01'), 100);
  near(cleanPrice(b, 0.06, '2020-07-01'), 100);
});
test('backward-generated EOM schedule matches caller-supplied leap February periods', () => {
  const b = {
    face: 100, couponRate: 0.04, frequency: 2, maturity: '2020-08-31',
    dayCount: 'ACT/ACT ICMA',
    referencePeriods: [
      { start: '2019-08-31', end: '2020-02-29' },
      { start: '2020-02-29', end: '2020-08-31' },
    ],
  };
  const generated = schedule(b, '2019-08-31');
  assert.deepEqual(generated.dates.map(d => d.toISOString().slice(0, 10)), ['2020-02-29', '2020-08-31']);
  assert.doesNotThrow(() => dirtyPrice(b, 0.04, '2019-08-31'));
});
test('missing and mismatched bond reference schedule are rejected', () => {
  const missing = {
    face: 100, couponRate: 0.06, frequency: 2,
    maturity: '2021-01-01', dayCount: 'ACT/ACT ICMA',
  };
  assert.throws(() => dirtyPrice(missing, 0.06, '2020-04-01'), /referencePeriods/);
  const wrong = {
    ...missing,
    referencePeriods: [
      { start: '2020-01-01', end: '2020-06-30' },
      { start: '2020-06-30', end: '2021-01-01' },
    ],
  };
  assert.throws(() => dirtyPrice(wrong, 0.06, '2020-04-01'));
});
test('bare ACT/ACT remains unsupported and distinct from ACT/ACT ICMA', () => {
  assert.throws(() => dayCountFraction(parseDate('2020-01-01'), parseDate('2021-01-01'), 'ACT/ACT'), /not implemented/);
  assert.doesNotThrow(() => assertSupportedConvention('ACT/ACT ICMA'));
});
// ============ IRICMA-REGRESSION: order, EOM rule, strict date strings ============
test('adjacency defects are reported before irregular shape', () => {
  // 30 Jul start overlaps the 31 Jul end AND is one-sided-EOM irregular; the overlap
  // in a neighbour pair must be the reported defect, not "irregular".
  assert.throws(() => icmaDayCountFraction([
      { start: '2019-01-31', end: '2019-07-31' },
      { start: '2019-07-30', end: '2020-01-31' },
    ], 2, '2019-01-31', '2020-01-31'), /overlap/);
  // A later, also-irregular period still reports its gap first.
  assert.throws(() => icmaDayCountFraction([
      { start: '2020-01-01', end: '2020-07-01' },
      { start: '2020-07-02', end: '2020-12-15' },
    ], 2, '2020-01-01', '2020-12-15'), /gap/);
});

test('EOM regularity requires both ends to be month ends', () => {
  // 31 Jan -> 30 Jul: month delta 6 but only the start is a month end - a stub, rejected.
  assert.throws(() => icmaDayCountFraction(
    [{ start: '2020-01-31', end: '2020-07-30' }], 2, '2020-01-31', '2020-07-30'),
    /irregular/);
  // 31 Jan -> 31 Jul: both ends are month ends - a regular coupon, accepted.
  near(icmaDayCountFraction(
    [{ start: '2019-01-31', end: '2019-07-31' }], 2, '2019-01-31', '2019-07-31'), 0.5);
});

test('ICMA date inputs must be strict YYYY-MM-DD strings', () => {
  const p = [{ start: '2020-01-01', end: '2020-07-01' }];
  assert.throws(() => icmaDayCountFraction(p, 2, parseDate('2020-01-01'), '2020-07-01'),
    /YYYY-MM-DD string/);
  assert.throws(() => icmaDayCountFraction(
    [{ start: parseDate('2020-01-01'), end: '2020-07-01' }], 2, '2020-01-01', '2020-07-01'),
    /YYYY-MM-DD string/);
  assert.throws(() => dayCountFraction(parseDate('2020-01-01'), parseDate('2020-07-01'),
    'ACT/ACT ICMA', { referencePeriods: p, frequency: 2 }), /YYYY-MM-DD string/);
});