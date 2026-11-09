$ErrorActionPreference = 'Stop'
$work = 'C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\workbench\act-act-icma'
$dayPath = Join-Path $work 'src\daycount.mjs'
$bondPath = Join-Path $work 'src\bond.mjs'
$legacyTestPath = Join-Path $work 'test\daycount.test.mjs'
$icmaTestPath = Join-Path $work 'test\act-act-icma.test.mjs'

# Update the scope note without relying on comment punctuation.
$day = ([System.IO.File]::ReadAllText($dayPath)) -replace "`r", ""
$headerStart = $day.IndexOf(' * Implemented:')
$headerEnd = $day.IndexOf(' * Also absent:', $headerStart)
if ($headerStart -lt 0 -or $headerEnd -lt 0) { throw 'DAYCOUNT_HEADER_NOT_FOUND' }
$newHeader = @'
 * Implemented: ACT/365F, ACT/360, 30/360 US (NASD), 30E/360 (Eurobond), and
 * ACT/ACT ICMA for regular coupons with an explicit reference-period schedule and frequency.
 *
 * NOT implemented: bare ACT/ACT, ACT/ACT ISDA, AFB, irregular ICMA stubs, ex-coupon periods,
 * and business-day calendars. ICMA is not an alias for those other conventions. US Treasuries
 * quote and settle on ACT/ACT; this ICMA increment does not claim Treasury-convention support.
 * A schedule-aware caller must supply actual coupon reference periods; a two-date call
 * deliberately refuses ICMA when those inputs are absent.
'@
$day = $day.Substring(0, $headerStart) + $newHeader + $day.Substring($headerEnd)

$helper = @'
/**
 * ACT/ACT ICMA year fraction over an explicit regular coupon reference schedule.
 * Each reference period is a half-open interval [start, end). The fraction is the
 * sum of actual overlap days divided by frequency times actual days in that reference
 * coupon period. Irregular/stub periods are deliberately rejected.
 */
export function icmaDayCountFraction(referencePeriods, frequency, start, end) {
  if (![1, 2, 4].includes(frequency)) {
    throw new RangeError('unsupported ICMA frequency: ' + frequency);
  }
  if (!Array.isArray(referencePeriods) || referencePeriods.length === 0) {
    throw new TypeError('ACT/ACT ICMA requires a non-empty explicit referencePeriods array');
  }
  const asUtcDate = (value, label) => {
    const date = parseDate(value);
    if (!Number.isFinite(date.getTime()) ||
        date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0 ||
        date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) {
      throw new TypeError(label + ' must be a valid UTC date at midnight');
    }
    return date;
  };
  const normalized = referencePeriods.map((period, index) => {
    if (!period || typeof period !== 'object' ||
        period.start === undefined || period.end === undefined) {
      throw new TypeError('reference period ' + index + ' must contain start and end');
    }
    const periodStart = asUtcDate(period.start, 'referencePeriods[' + index + '].start');
    const periodEnd = asUtcDate(period.end, 'referencePeriods[' + index + '].end');
    const days = daysBetween(periodStart, periodEnd);
    if (days <= 0) {
      throw new RangeError(days === 0
        ? 'reference period ' + index + ' has zero length'
        : 'reference period ' + index + ' end precedes start');
    }
    const monthDelta =
      (periodEnd.getUTCFullYear() - periodStart.getUTCFullYear()) * 12 +
      (periodEnd.getUTCMonth() - periodStart.getUTCMonth());
    const regularDates =
      periodStart.getUTCDate() === periodEnd.getUTCDate() ||
      (isLastDayOfMonth(periodStart) && isLastDayOfMonth(periodEnd));
    if (monthDelta !== 12 / frequency || !regularDates) {
      throw new RangeError(
        'irregular ACT/ACT ICMA reference period ' + index + '; stubs are not supported'
      );
    }
    if (index > 0) {
      const previousEnd = normalized[index - 1].end;
      const delta = daysBetween(previousEnd, periodStart);
      if (delta > 0) {
        throw new RangeError('gap of ' + delta + ' day(s) before reference period ' + index);
      }
      if (delta < 0) {
        throw new RangeError('reference period ' + (index - 1) + ' overlaps period ' + index);
      }
    }
    return { start: periodStart, end: periodEnd, days };
  });

  const a = asUtcDate(start, 'start');
  const b = asUtcDate(end, 'end');
  if (daysBetween(a, b) < 0) throw new RangeError('end precedes start');
  const first = normalized[0].start;
  const last = normalized[normalized.length - 1].end;
  if (daysBetween(first, a) < 0 || daysBetween(a, last) < 0) {
    throw new RangeError('start is outside ACT/ACT ICMA reference schedule coverage');
  }
  if (daysBetween(first, b) < 0 || daysBetween(b, last) < 0) {
    throw new RangeError('end is outside ACT/ACT ICMA reference schedule coverage');
  }
  let fraction = 0;
  for (const period of normalized) {
    const overlapStart = a > period.start ? a : period.start;
    const overlapEnd = b < period.end ? b : period.end;
    const overlapDays = daysBetween(overlapStart, overlapEnd);
    if (overlapDays > 0) {
      fraction += overlapDays / (frequency * period.days);
    }
  }
  return fraction;
}

'@
$phrase = ' * Year fraction between two dates under a convention.'
$phraseIndex = $day.IndexOf($phrase)
if ($phraseIndex -lt 0) { throw 'DAYCOUNT_INSERT_PHRASE_NOT_FOUND' }
$insertAt = $day.LastIndexOf('/**', $phraseIndex)
if ($insertAt -lt 0) { throw 'DAYCOUNT_INSERT_DOCBLOCK_NOT_FOUND' }
$day = $day.Insert($insertAt, $helper)
$oldSignature = 'export function dayCountFraction(start, end, convention) {'
if (-not $day.Contains($oldSignature)) { throw 'DAYCOUNT_SIGNATURE_NOT_FOUND' }
$day = $day.Replace($oldSignature, 'export function dayCountFraction(start, end, convention, options = {}) {')

$switchStart = $day.IndexOf('  switch (convention) {')
if ($switchStart -lt 0) { throw 'DAYCOUNT_SWITCH_NOT_FOUND' }
$caseStart = $day.IndexOf("    case 'ACT/365F':", $switchStart)
if ($caseStart -lt 0) { throw 'DAYCOUNT_ACT365_CASE_NOT_FOUND' }
$icmaCase = "    case 'ACT/ACT ICMA':" + [string][char]10 +
  '      return icmaDayCountFraction(options.referencePeriods, options.frequency, a, b);' + [string][char]10 + [string][char]10
$day = $day.Insert($caseStart, $icmaCase)

$oldSupported = "['ACT/365F', 'ACT/360', '30/360 US', '30E/360'].includes(convention)"
$newSupported = "['ACT/365F', 'ACT/360', '30/360 US', '30E/360', 'ACT/ACT ICMA'].includes(convention)"
if (-not $day.Contains($oldSupported)) { throw 'SUPPORTED_CONVENTION_LIST_NOT_FOUND' }
$day = $day.Replace($oldSupported, $newSupported)
$day = $day.Replace('ACT/ACT is deliberately refused rather than approximated.', 'Bare ACT/ACT is deliberately refused rather than approximated.')
[System.IO.File]::WriteAllText($dayPath, $day, (New-Object System.Text.UTF8Encoding($false)))

$bond = ([System.IO.File]::ReadAllText($bondPath)) -replace "`r", ""
$oldImport = "import { parseDate, addMonths, dayCountFraction, daysBetween, assertSupportedConvention } from './daycount.mjs';"
$newImport = "import { parseDate, addMonths, dayCountFraction, daysBetween, assertSupportedConvention, icmaDayCountFraction } from './daycount.mjs';"
if (-not $bond.Contains($oldImport)) { throw 'BOND_IMPORT_NOT_FOUND' }
$bond = $bond.Replace($oldImport, $newImport)

$oldRound = '  assertSupportedConvention(b.dayCount);' + [string][char]10 + '  if (![1, 2, 4].includes(b.frequency))'
$newRound = '  assertSupportedConvention(b.dayCount);' + [string][char]10 + "  if (b.dayCount === 'ACT/ACT ICMA' && (!Array.isArray(b.referencePeriods) || b.referencePeriods.length === 0)) {" + [string][char]10 + "    throw new TypeError('ACT/ACT ICMA requires bond.referencePeriods and frequency');" + [string][char]10 + '  }' + [string][char]10 + '  if (![1, 2, 4].includes(b.frequency))'
if (-not $bond.Contains($oldRound)) { throw 'BOND_ROUNDTRIP_ANCHOR_NOT_FOUND' }
$bond = $bond.Replace($oldRound, $newRound)

$bondHelper = @'
/**
 * Validate the caller-supplied reference schedule against backward-generated coupon
 * boundaries. Earlier periods may be supplied; use the suffix beginning at the previous
 * coupon boundary for the current settlement. No reference date is inferred.
 */
function referencePeriodsForBond(bond, generated) {
  if (bond.dayCount !== 'ACT/ACT ICMA') return null;
  const supplied = bond.referencePeriods;
  if (!Array.isArray(supplied) || supplied.length === 0) {
    throw new TypeError('ACT/ACT ICMA requires bond.referencePeriods');
  }
  const firstStart = parseDate(supplied[0].start);
  const finalEnd = parseDate(supplied[supplied.length - 1].end);
  if (finalEnd.getTime() !== parseDate(bond.maturity).getTime()) {
    throw new RangeError('ACT/ACT ICMA reference schedule must end at bond maturity');
  }
  icmaDayCountFraction(supplied, bond.frequency, firstStart, finalEnd);
  const previous = generated.previous.getTime();
  const firstIndex = supplied.findIndex((period) => parseDate(period.start).getTime() === previous);
  if (firstIndex < 0) {
    throw new RangeError('ACT/ACT ICMA reference schedule does not include the previous coupon boundary');
  }
  const required = supplied.slice(firstIndex);
  if (required.length !== generated.dates.length) {
    throw new RangeError('ACT/ACT ICMA reference schedule does not match remaining coupon count');
  }
  for (let i = 0; i < required.length; i++) {
    const expectedStart = i === 0 ? generated.previous : generated.dates[i - 1];
    const expectedEnd = generated.dates[i];
    if (parseDate(required[i].start).getTime() !== expectedStart.getTime() ||
        parseDate(required[i].end).getTime() !== expectedEnd.getTime()) {
      throw new RangeError('ACT/ACT ICMA reference periods do not match generated coupon dates at index ' + i);
    }
  }
  return required;
}

function bondDayCountFraction(bond, start, end, referencePeriods) {
  if (bond.dayCount === 'ACT/ACT ICMA') {
    return dayCountFraction(start, end, bond.dayCount, {
      referencePeriods,
      frequency: bond.frequency,
    });
  }
  return dayCountFraction(start, end, bond.dayCount);
}

'@
$bondAnchor = '/** Discount factor for a time'
if (-not $bond.Contains($bondAnchor)) { throw 'BOND_HELPER_INSERT_ANCHOR_NOT_FOUND' }
$bond = $bond.Replace($bondAnchor, $bondHelper + $bondAnchor)

$oldDirty = @'
  const { dates } = schedule(bond, s);
  const c = couponPerPeriod(bond);

  let pv = 0;
  for (const d of dates) {
    const t = dayCountFraction(s, d, bond.dayCount);
    pv += c * discount(t, y, bond.frequency);
  }
  const tM = dayCountFraction(s, parseDate(bond.maturity), bond.dayCount);
'@
$newDirty = @'
  const generated = schedule(bond, s);
  const { dates } = generated;
  const referencePeriods = referencePeriodsForBond(bond, generated);
  const c = couponPerPeriod(bond);

  let pv = 0;
  for (const d of dates) {
    const t = bondDayCountFraction(bond, s, d, referencePeriods);
    pv += c * discount(t, y, bond.frequency);
  }
  const tM = bondDayCountFraction(bond, s, parseDate(bond.maturity), referencePeriods);
'@
if (-not $bond.Contains($oldDirty)) { throw 'BOND_DIRTY_PRICE_BLOCK_NOT_FOUND' }
$bond = $bond.Replace($oldDirty, $newDirty)

$oldAccrued = @'
  const { dates, previous } = schedule(bond, s);

  if (daysBetween(previous, s) === 0) return 0;

  let next = dates[0];
  for (const d of dates) {
    if (daysBetween(d, s) > 0) { next = d; break; }
  }

  const elapsed = dayCountFraction(previous, s, bond.dayCount);
  const whole = dayCountFraction(previous, next, bond.dayCount);
'@
$newAccrued = @'
  const generated = schedule(bond, s);
  const { dates, previous } = generated;
  const referencePeriods = referencePeriodsForBond(bond, generated);

  if (daysBetween(previous, s) === 0) return 0;

  let next = dates[0];
  for (const d of dates) {
    if (daysBetween(d, s) > 0) { next = d; break; }
  }

  const elapsed = bondDayCountFraction(bond, previous, s, referencePeriods);
  const whole = bondDayCountFraction(bond, previous, next, referencePeriods);
'@
if (-not $bond.Contains($oldAccrued)) { throw 'BOND_ACCRUED_BLOCK_NOT_FOUND' }
$bond = $bond.Replace($oldAccrued, $newAccrued)
[System.IO.File]::WriteAllText($bondPath, $bond, (New-Object System.Text.UTF8Encoding($false)))

$legacy = ([System.IO.File]::ReadAllText($legacyTestPath)) -replace "`r", ""
$oldAssertion = "  assert.throws(() => assertSupportedConvention('ACT/ACT ICMA'), /not implemented/);"
$newAssertion = @'
  assert.doesNotThrow(() => assertSupportedConvention('ACT/ACT ICMA'));
  assert.throws(
    () => dayCountFraction(parseDate('2020-01-01'), parseDate('2021-01-01'), 'ACT/ACT ICMA'),
    /referencePeriods/
  );
'@
if (-not $legacy.Contains($oldAssertion)) { throw 'LEGACY_TEST_ICMA_ASSERTION_NOT_FOUND' }
$legacy = $legacy.Replace($oldAssertion, $newAssertion.TrimEnd())
[System.IO.File]::WriteAllText($legacyTestPath, $legacy, (New-Object System.Text.UTF8Encoding($false)))

$icmaTests = @'
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
'@
[System.IO.File]::WriteAllText($icmaTestPath, $icmaTests, (New-Object System.Text.UTF8Encoding($false)))

$review = @'
# PR-style review: ACT/ACT ICMA (isolated prototype)

Status: prototype only; not merged into the canonical repository.

## API
- icmaDayCountFraction(referencePeriods, frequency, start, end) requires an explicit non-empty array of { start, end } coupon reference periods and frequency 1, 2, or 4.
- dayCountFraction(start, end, 'ACT/ACT ICMA', { referencePeriods, frequency }) delegates to the schedule-aware implementation. A two-date ICMA call without the schedule is rejected.
- Bond objects using dayCount: 'ACT/ACT ICMA' must include referencePeriods. The schedule must be regular, contiguous, cover the bond to maturity, and match backward-generated coupon boundaries.

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
- Bond example, 2020-04-01 settlement: 91 elapsed days in a 182-day semiannual coupon period; accrued coupon = 3 * 91/182 = 1.5. Dirty price uses 1/4 and 3/4 years for remaining cashflows.

## Deliberate limitations
- Only ACT/ACT ICMA; not bare ACT/ACT, ACT/ACT ISDA, AFB, or a generic Treasury alias.
- Regular reference periods only. Stubs and irregular first/last coupons are rejected, not inferred.
- No ex-coupon rules, business-day calendars, floating-rate or amortizing instruments.
- This is fixed-income arithmetic only; no market quotes, live feeds, portfolio holdings, order execution or trading.

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
Write-Output 'ICMA prototype files written.'
