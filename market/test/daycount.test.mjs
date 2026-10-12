/**
 * Bond pricing tests.
 *
 * Every expected value here is derived by hand, not captured from a previous run. A test
 * suite that records the output of the code it is testing cannot fail when the code is
 * wrong; it just confirms the code still does whatever it did.
 *
 * Nothing in this file reads market data. That is deliberate: the pricing core can be
 * verified completely before any feed exists, so a broken feed and a broken formula can
 * never be confused for one another.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ymd, parseDate, daysBetween, daysInMonth, isLastDayOfMonth,
  addDays, addMonths, dayCountFraction, assertSupportedConvention,
} from '../src/daycount.mjs';

import {
  couponPerPeriod, schedule, dirtyPrice, cleanPrice, accruedInterest,
  yieldFromDirtyPrice, sensitivities, dv01,
} from '../src/bond.mjs';

const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol,
    `${what}: ${actual} is not within ${tol} of ${expected}`);

// ------------------------------------------------------------------ date arithmetic

test('a day is a fixed 86,400,000 ms; there is no local time anywhere in this core', () => {
  assert.equal(daysBetween(parseDate('2020-01-01'), parseDate('2020-01-02')), 1);
  assert.equal(daysBetween(parseDate('2020-01-01'), parseDate('2021-01-01')), 366, '2020 is a leap year');
  assert.equal(daysBetween(parseDate('2019-01-01'), parseDate('2020-01-01')), 365);
});

test('a date that does not exist is rejected rather than rolled over', () => {
  assert.throws(() => ymd(2019, 2, 29), /does not exist/);
  assert.throws(() => ymd(2021, 13, 1), /month out of range/);
  assert.equal(parseDate('2020-02-29').getUTCDate(), 29, '2020 really does have one');
});

test('malformed dates are rejected, not guessed at', () => {
  for (const bad of ['2020-1-1', '01/01/2020', 'yesterday', '', '2020-01-01T00:00:00Z']) {
    assert.throws(() => parseDate(bad), TypeError, `${bad} must be rejected`);
  }
});

test('month arithmetic clamps to month end instead of overflowing', () => {
  // 31 Jan + 1 month is 28 Feb, not 3 March. An overflow here silently drifts a schedule
  // away from the contract's actual coupon dates.
  assert.equal(addMonths(parseDate('2019-01-31'), 1, 'limit').toISOString().slice(0, 10), '2019-02-28');
  assert.equal(addMonths(parseDate('2020-01-31'), 1, 'limit').toISOString().slice(0, 10), '2020-02-29');
  assert.equal(addMonths(parseDate('2020-01-31'), 1, 'none').toISOString().slice(0, 10), '2020-03-02');
  assert.equal(addMonths(parseDate('2020-06-15'), -6, 'limit').toISOString().slice(0, 10), '2019-12-15');
  assert.equal(addMonths(parseDate('2020-08-31'), -6, 'limit').toISOString().slice(0, 10), '2020-02-29');
});

test('last-day-of-month detection covers both ordinary and leap Februaries', () => {
  assert.equal(isLastDayOfMonth(parseDate('2019-02-28')), true);
  assert.equal(isLastDayOfMonth(parseDate('2020-02-29')), true);
  assert.equal(isLastDayOfMonth(parseDate('2020-02-28')), false);
  assert.equal(isLastDayOfMonth(parseDate('2020-04-30')), true);
  assert.equal(daysInMonth(2020, 2), 29);
  assert.equal(daysInMonth(2019, 2), 28);
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays(parseDate('2019-12-31'), 1).toISOString().slice(0, 10), '2020-01-01');
  assert.equal(addDays(parseDate('2020-02-28'), 1).toISOString().slice(0, 10), '2020-02-29');
});

// ------------------------------------------------------------------ day counts

test('ACT/365F and ACT/360 differ by exactly the denominator', () => {
  const a = parseDate('2020-01-01');
  const b = parseDate('2021-01-01');
  near(dayCountFraction(a, b, 'ACT/365F'), 366 / 365, 1e-12, 'ACT/365F over a leap year');
  near(dayCountFraction(a, b, 'ACT/360'), 366 / 360, 1e-12, 'ACT/360');
});

test('30/360 counts a whole year as exactly one, regardless of leap days', () => {
  near(dayCountFraction(parseDate('2020-01-01'), parseDate('2021-01-01'), '30/360 US'), 1, 1e-12, '30/360 US');
  near(dayCountFraction(parseDate('2020-01-01'), parseDate('2021-01-01'), '30E/360'), 1, 1e-12, '30E/360');
  near(dayCountFraction(parseDate('2019-01-01'), parseDate('2020-01-01'), '30/360 US'), 1, 1e-12, 'non-leap');
});

test('30/360 US applies the February end-of-month rule', () => {
  // 2019-02-28 -> 2019-08-31: August 31 becomes August 30 because the start is a February
  // month end. Six months plus two days.
  near(dayCountFraction(parseDate('2019-02-28'), parseDate('2019-08-31'), '30/360 US'),
    182 / 360, 1e-12, 'Feb EOM rule');
});

test('30/360 US and 30E/360 genuinely disagree across a leap February', () => {
  // The classic divergence: US treats both ends as month-ends, E only demotes day 31.
  // 2020-02-29 -> 2021-02-28 is 361/360 US and 359/360 Eurobond; they sum to exactly two.
  const us = dayCountFraction(parseDate('2020-02-29'), parseDate('2021-02-28'), '30/360 US');
  const eu = dayCountFraction(parseDate('2020-02-29'), parseDate('2021-02-28'), '30E/360');
  near(us, 361 / 360, 1e-12, '30/360 US');
  near(eu, 359 / 360, 1e-12, '30E/360');
  near(us + eu, 2, 1e-12, 'the two conventions bracket the true year');
});

test('30E/360 demotes day 31 without the February rule', () => {
  near(dayCountFraction(parseDate('2020-01-31'), parseDate('2020-03-31'), '30E/360'),
    60 / 360, 1e-12, 'both ends demoted');
});

test('a backwards date range is rejected', () => {
  assert.throws(() => dayCountFraction(parseDate('2021-01-01'), parseDate('2020-01-01'), 'ACT/365F'),
    /end precedes start/);
});

test('ACT/ACT is refused rather than approximated', () => {
  // US Treasuries settle on ACT/ACT. Silently using 365 would price them a basis point or
  // two wrong on every coupon, and the result would look entirely normal.
  assert.throws(() => dayCountFraction(parseDate('2020-01-01'), parseDate('2021-01-01'), 'ACT/ACT'),
    /not implemented/);
  assert.throws(() => assertSupportedConvention('ACT/ACT ICMA'), /not implemented/);
});

// ------------------------------------------------------------------ schedules

const ANNUAL = {
  face: 100, couponRate: 0.06, frequency: 1,
  maturity: '2030-01-01', dayCount: '30/360 US',
};

const SEMI = {
  face: 100, couponRate: 0.06, frequency: 2,
  maturity: '2030-06-15', dayCount: '30/360 US',
};

const ZERO = {
  face: 100, couponRate: 0, frequency: 1,
  maturity: '2030-01-01', dayCount: '30/360 US',
};

test('a ten-year annual bond has ten remaining coupons', () => {
  const { dates, previous } = schedule(ANNUAL, '2020-01-01');
  assert.equal(dates.length, 10);
  assert.equal(dates[0].toISOString().slice(0, 10), '2021-01-01', 'earliest first');
  assert.equal(dates[dates.length - 1].toISOString().slice(0, 10), '2030-01-01');
  assert.equal(previous.toISOString().slice(0, 10), '2020-01-01');
});

test('a ten-year semi-annual bond has twenty remaining coupons', () => {
  const { dates, previous } = schedule(SEMI, '2020-06-15');
  assert.equal(dates.length, 20);
  assert.equal(previous.toISOString().slice(0, 10), '2020-06-15');
});

test('schedules are generated backward from maturity, so they do not drift', () => {
  // Forward generation from 2020-06-15 would land on 2030-06-15 too, but only because
  // every date is mid-month. Backward generation is anchored on the one contractual date.
  const { dates } = schedule(SEMI, '2020-06-15');
  for (const d of dates) {
    assert.ok([15].includes(d.getUTCDate()), `coupon date ${d.toISOString()} drifted off day 15`);
  }
});

test('a settlement after maturity is rejected', () => {
  assert.throws(() => schedule(ANNUAL, '2031-01-01'), /after maturity/);
});

test('an unsupported coupon frequency is rejected', () => {
  assert.throws(() => schedule({ ...ANNUAL, frequency: 3 }, '2020-01-01'), /unsupported frequency/);
  assert.throws(() => schedule({ ...ANNUAL, couponRate: 1.5 }, '2020-01-01'), /coupon rate out of range/);
  assert.throws(() => schedule({ ...ANNUAL, face: 0 }, '2020-01-01'), /face must be positive/);
});

// ------------------------------------------------------------------ pricing

test('coupon per period is face times rate times one over frequency', () => {
  near(couponPerPeriod(ANNUAL), 6, 1e-12, 'annual');
  near(couponPerPeriod(SEMI), 3, 1e-12, 'semi-annual');
  near(couponPerPeriod(ZERO), 0, 1e-12, 'zero coupon');
});

test('a bond priced at its own coupon rate is exactly at par', () => {
  // 100 at 6% annual for ten years discounted at 6%: the textbook par bond.
  // 6 * (1 - v^10)/0.06 + 100 v^10 = 100 exactly, because 6/0.06 = 100.
  near(dirtyPrice(ANNUAL, 0.06, '2020-01-01'), 100, 1e-9, 'annual par bond');
  near(dirtyPrice(SEMI, 0.06, '2020-06-15'), 100, 1e-9, 'semi-annual par bond');
});

test('a zero-coupon bond is the face discounted over the whole term', () => {
  // 1.06^10 = 1.7908476965..., so 100/1.06^10 = 55.8394777
  near(dirtyPrice(ZERO, 0.06, '2020-01-01'), 55.8394777, 1e-6, 'zero coupon');
});

test('price falls as yield rises', () => {
  let last = Infinity;
  for (const y of [0.01, 0.03, 0.06, 0.09, 0.15, 0.25]) {
    const p = dirtyPrice(ANNUAL, y, '2020-01-01');
    assert.ok(p < last, `price must fall: ${p} was not below ${last} at yield ${y}`);
    last = p;
  }
});

test('price rises as the coupon rises, at a fixed yield', () => {
  const cheap = dirtyPrice({ ...ANNUAL, couponRate: 0.02 }, 0.06, '2020-01-01');
  const dear = dirtyPrice({ ...ANNUAL, couponRate: 0.10 }, 0.06, '2020-01-01');
  assert.ok(dear > cheap, 'a higher coupon must be worth more at the same yield');
});

test('a longer maturity is worth less than a shorter one, at a fixed yield', () => {
  const near5y = dirtyPrice({ ...ANNUAL, maturity: '2025-01-01' }, 0.06, '2020-01-01');
  const far10y = dirtyPrice(ANNUAL, 0.06, '2020-01-01');
  assert.ok(far10y < near5y, 'more cash further out must be worth less');
});

test('one day before maturity the price is the face plus one day of accrual', () => {
  // Only the final coupon and the principal remain, both one day out: 106 / 1.06^(1/360).
  near(dirtyPrice(ANNUAL, 0.06, '2029-12-31'), 105.98284, 1e-4, 'one day before maturity');
});

// ------------------------------------------------------------------ accrual

test('nothing accrues on a coupon date', () => {
  // The classic bug is settling on the coupon date and still charging a coupon's interest.
  near(accruedInterest(SEMI, '2020-06-15'), 0, 1e-12, 'on the coupon date');
  near(accruedInterest(SEMI, '2021-06-15'), 0, 1e-12, 'on a later coupon date');
});

test('accrual is proportional through the coupon period', () => {
  // Exactly halfway through the 2020-06-15 -> 2020-12-15 period: half of 3.
  near(accruedInterest(SEMI, '2020-09-15'), 1.5, 1e-12, 'mid period');
  // One day before the coupon date: 179/360 of a half-year period = 179/180 of a coupon.
  near(accruedInterest(SEMI, '2020-12-14'), 3 * (179 / 180), 1e-12, 'one day before coupon');
  // One day after: 1/360 of the next period = 1/180 of a coupon.
  near(accruedInterest(SEMI, '2020-12-16'), 3 * (1 / 180), 1e-12, 'one day after coupon');
});

test('accrual uses the day-count convention, not a naive day count', () => {
  // ACT/365F over the same span gives a different fraction than 30/360's exact half-year,
  // which is the whole reason the convention is an input rather than a constant.
  const usd = accruedInterest({ ...SEMI, dayCount: '30/360 US' }, '2020-09-15');
  const act = accruedInterest({ ...SEMI, dayCount: 'ACT/365F' }, '2020-09-15');
  assert.notEqual(usd, act, 'the convention must change the answer');
  near(usd, 1.5, 1e-12, '30/360 is exactly half a coupon period');
  near(act, 3 * (93 / 365) / (184 / 365), 1e-12, 'ACT/365F by actual days');
});

test('clean price is dirty price less accrued interest', () => {
  const y = 0.06;
  const s = '2020-09-15';
  near(cleanPrice(SEMI, y, s), dirtyPrice(SEMI, y, s) - accruedInterest(SEMI, s), 1e-12, 'clean = dirty - accrued');
  assert.ok(cleanPrice(SEMI, y, s) < dirtyPrice(SEMI, y, s), 'a dirty price includes what the seller earns');
});

// ------------------------------------------------------------------ yield and risk

test('implied yield round-trips through price', () => {
  for (const y of [0.005, 0.02, 0.06, 0.11, 0.24]) {
    const p = dirtyPrice(ANNUAL, y, '2020-01-01');
    const back = yieldFromDirtyPrice(ANNUAL, p, '2020-01-01');
    near(back, y, 1e-10, `round trip at ${y}`);
  }
});

test('implied yield round-trips mid-coupon, where the accrual kink lives', () => {
  const p = dirtyPrice(SEMI, 0.075, '2021-03-15');
  near(yieldFromDirtyPrice(SEMI, p, '2021-03-15'), 0.075, 1e-9, 'mid-coupon round trip');
});

test('an unreachable price is reported, not bisected into a confident wrong answer', () => {
  assert.throws(() => yieldFromDirtyPrice(ANNUAL, 1e9, '2020-01-01'), /outside the achievable range/);
  assert.throws(() => yieldFromDirtyPrice(ANNUAL, -5, '2020-01-01'), /outside the achievable range/);
});

test('modified duration is positive and convexity is positive for a coupon bond', () => {
  const s = sensitivities(ANNUAL, 0.06, '2020-01-01');
  assert.ok(s.modifiedDuration > 0, 'a bond loses value as yield rises');
  assert.ok(s.convexity > 0, 'bond convexity is positive');
});

test('a zero-coupon bond has convexity near zero', () => {
  // With no cash flows before maturity, discounting is almost linear in yield, so the
  // second derivative vanishes. A non-trivial value here would mean coupons leaked in.
  const s = sensitivities(ZERO, 0.06, '2020-01-01');
  assert.ok(s.convexity >= 0, `convexity should not be negative, got ${s.convexity}`);
  assert.ok(s.convexity < 1e-4, `convexity should be ~0 for a zero coupon, got ${s.convexity}`);
});

test('a zero-coupon bond has duration equal to its time to maturity', () => {
  // Modified duration of a single payment at T years, at yield y, is T/(1+y).
  const T = 10, y = 0.06;
  near(sensitivities(ZERO, y, '2020-01-01').modifiedDuration, T / (1 + y), 1e-4, 'zero coupon duration');
});

test('duration falls as the bond approaches maturity', () => {
  const early = sensitivities(SEMI, 0.06, '2020-06-15').modifiedDuration;
  const later = sensitivities(SEMI, 0.06, '2030-01-15').modifiedDuration;
  assert.ok(later < early, `duration must fall: ${later} was not below ${early}`);
});

test('DV01 is modified duration times price times one basis point', () => {
  const s = sensitivities(ANNUAL, 0.06, '2020-01-01');
  near(dv01(ANNUAL, 0.06, '2020-01-01'), s.modifiedDuration * s.dirtyPrice * 1e-4, 1e-12, 'DV01');
});

test('a one-basis-point rise in yield loses roughly one DV01', () => {
  const y = 0.06, s = '2020-01-01';
  const p0 = dirtyPrice(ANNUAL, y, s);
  const p1 = dirtyPrice(ANNUAL, y + 1e-4, s);
  const predicted = -dv01(ANNUAL, y, s);
  const actual = p1 - p0;
  near(actual, predicted, Math.abs(predicted) * 1e-6 + 1e-9, 'DV01 predicts the one-bp move');
  assert.ok(actual < 0, 'a yield rise must cost money');
});

test('a two-basis-point loss is less than twice the one-basis-point loss', () => {
  // Convexity, observed directly: the gain from falling yields is smaller than the loss
  // from rising them, for the same magnitude move.
  const y = 0.06, s = '2020-01-01';
  const d = dv01(ANNUAL, y, s);
  const up2 = dirtyPrice(ANNUAL, y + 2e-4, s) - dirtyPrice(ANNUAL, y, s);
  const dn2 = dirtyPrice(ANNUAL, y - 2e-4, s) - dirtyPrice(ANNUAL, y, s);
  assert.ok(up2 < 0 && dn2 > 0, 'the right signs');
  assert.ok(Math.abs(up2) < 2 * d, 'convexity must make the two-bp loss smaller than 2x DV01');
  assert.ok(Math.abs(dn2) < 2 * d, 'convexity must make the two-bp gain smaller than 2x DV01');
});
