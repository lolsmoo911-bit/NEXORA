$ErrorActionPreference = 'Stop'
$work = 'C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\workbench\act-act-icma'
$testPath = Join-Path $work 'test\act-act-icma.test.mjs'

$tests = @'
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
test('EOM leap-February reference boundaries are supported', () => {
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
test('backward-generated EOM schedule matches explicit February coupon periods', () => {
  const b = {
    face: 100, couponRate: 0.04, frequency: 2, maturity: '2020-08-31',
    dayCount: 'ACT/ACT ICMA',
    referencePeriods: [
      { start: '2019-08-29', end: '2020-02-29' },
      { start: '2020-02-29', end: '2020-08-31' },
    ],
  };
  const generated = schedule(b, '2019-08-29');
  assert.deepEqual(generated.dates.map(d => d.toISOString().slice(0, 10)), ['2020-02-29', '2020-08-31']);
  assert.doesNotThrow(() => dirtyPrice(b, 0.04, '2019-08-29'));
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
'@
[System.IO.File]::WriteAllText($testPath, $tests, (New-Object System.Text.UTF8Encoding($false)))

$review = @'
# PR-style review: ACT/ACT ICMA (isolated prototype)

Status: prototype only; not merged into the canonical repository.

## API
- icmaDayCountFraction(referencePeriods, frequency, start, end) requires an explicit non-empty array of { start, end } coupon reference periods and frequency 1, 2, or 4.
- dayCountFraction(start, end, ACT/ACT ICMA, { referencePeriods, frequency }) delegates to the schedule-aware implementation. A two-date ICMA call without the schedule is rejected.
- Bond objects using ACT/ACT ICMA must include referencePeriods. The schedule must be regular, contiguous, cover the bond to maturity, and match backward-generated coupon boundaries.

## Mathematical definition
For each reference period i, let D_i be its actual calendar-day length, f the coupon frequency, and O_i the actual overlap days between the requested interval and that period. The year fraction is:

sum_i O_i / (f * D_i)

All intervals are half-open [start, end); dates are strict UTC calendar dates.

## Hand-derived checks
- Full annual period: 366 / (1 * 366) = 1.
- Full semiannual period: 182 / (2 * 182) = 1/2.
- Full quarterly period: 91 / (4 * 91) = 1/4.
- 2020-07-02 to 2022-07-02: 183/366 + 1 + 182/365.
- EOM periods 2019-08-31 to 2020-02-29 (182 days) and 2020-02-29 to 2020-08-31 (184 days): each semiannual fraction is 1/2.
- Bond example, 2020-04-01 settlement: 91 elapsed days in a 182-day semiannual coupon period; accrued coupon = 3 * 91/182 = 1.5. Dirty price uses 1/4 and 3/4 years for the remaining cashflows.

## Limitations
- Only ACT/ACT ICMA; not bare ACT/ACT, ACT/ACT ISDA, AFB, or a generic Treasury alias.
- Regular reference periods only. Stubs and irregular first/last coupons are rejected, not inferred.
- No ex-coupon rules, business-day calendars, floating-rate or amortizing instruments.
- Fixed-income arithmetic only; no live quotes, feeds, order execution or trading.

## Proposed upstream files (not changed here)
- market/src/daycount.mjs
- market/src/bond.mjs
- market/test/daycount.test.mjs
- market/test/act-act-icma.test.mjs
- market/README.md or fixed-income convention documentation.

The canonical upstream-nexora files, GitHub repository and Market Data Hub are intentionally untouched.
'@
[System.IO.File]::WriteAllText((Join-Path $work 'PR-REVIEW.md'), $review, (New-Object System.Text.UTF8Encoding($false)))
Add-Content -LiteralPath (Join-Path $work 'WORK-STATUS.txt') -Value @(
  '',
  'Implementation status: isolated ACT/ACT ICMA prototype written; verification pending.',
  'Prototype files: src/daycount.mjs, src/bond.mjs, test/daycount.test.mjs, test/act-act-icma.test.mjs, PR-REVIEW.md.',
  'Canonical upstream sources have not been edited.'
) -Encoding UTF8
Write-Output 'ICMA tests and review documents written.'
