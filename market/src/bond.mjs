/**
 * Fixed-rate bond pricing.
 *
 * Pure functions over explicit arguments. No clock, no network, no market data. That is a
 * design constraint, not an accident: the only way to be confident a pricing core is right
 * is to test it against values that can be derived by hand, and a function that reads the
 * wall clock cannot be pinned to one.
 *
 * Yield convention: annual nominal, compounded `frequency` times a year, the way a quoted
 * yield is. Time is measured in year fractions from the settlement date, under the bond's
 * own day-count convention.
 *
 * SCOPE, STATED PLAINLY
 * ---------------------
 * Straight fixed-rate coupons only. Not implemented: floating-rate, amortising, callable,
 * putable, convertible, zero-coupon-with-accrual edge cases, ex-coupon settlement, business
 * day adjustment, and ACT/ACT (see daycount.mjs). A core that pretended to price all of
 * those would be lying about its own coverage.
 */

import { parseDate, addMonths, dayCountFraction, daysBetween, assertSupportedConvention } from './daycount.mjs';

/**
 * @typedef {object} Bond
 * @property {number} face          face value, conventionally 100
 * @property {number} couponRate    annual rate as a decimal (0.0425 = 4.25%)
 * @property {1|2|4} frequency     coupons per year
 * @property {string} maturity      YYYY-MM-DD
 * @property {string} dayCount      day-count convention
 * @property {string} [eom]         end-of-month rule for coupon dates: 'limit' (default)
 */

const roundTrip = (b) => {
  assertSupportedConvention(b.dayCount);
  if (![1, 2, 4].includes(b.frequency)) throw new RangeError(`unsupported frequency: ${b.frequency}`);
  if (!(b.couponRate >= 0 && b.couponRate < 1)) throw new RangeError(`coupon rate out of range: ${b.couponRate}`);
  if (!(b.face > 0)) throw new RangeError(`face must be positive: ${b.face}`);
  return b;
};

/** Coupon amount for one period. */
export const couponPerPeriod = (bond) => (bond.face * bond.couponRate) / bond.frequency;

/**
 * Coupon dates after `settlement`, plus the nearest date on or before it.
 *
 * Generated BACKWARD from maturity. Forward generation accumulates rounding: a schedule
 * built by adding three months a hundred times drifts from the contract's actual dates, and
 * a drifted schedule prices a different bond than the one quoted. Working back from the one
 * date that is contractual avoids the drift entirely.
 *
 * @returns {{ dates: Date[], previous: Date|null }}
 */
export function schedule(bond, settlement) {
  roundTrip(bond);
  const s = parseDate(settlement);
  const step = 12 / bond.frequency;
  let d = parseDate(bond.maturity);

  if (daysBetween(s, d) < 0) throw new RangeError(`settlement is after maturity of ${bond.maturity}`);

  const dates = [];
  // Bounded by a sane maximum: a 200-year schedule at quarterly frequency is 800 entries.
  // Without the bound, a malformed maturity loops forever instead of failing.
  for (let i = 0; i < 2000 && d > s; i++) {
    dates.push(d);
    d = addMonths(d, -step, bond.eom || 'limit');
  }
  dates.reverse();

  if (dates.length === 0) throw new RangeError('maturity is not after settlement');
  if (daysBetween(d, s) < 0) {
    throw new RangeError(`bond has not started accruing by ${settlement}`);
  }
  return { dates, previous: d };
}

/** Discount factor for a time `t` in years, at annual nominal yield `y`. */
const discount = (t, y, frequency) => Math.pow(1 + y / frequency, -frequency * t);

/**
 * Full (dirty) price per unit of face, at yield `y`.
 *
 * Sum of the present value of every remaining coupon plus the present value of the face
 * value at maturity. `t` is measured from settlement under the bond's day-count convention,
 * so the first period is short or long exactly as the convention says.
 */
export function dirtyPrice(bond, y, settlement) {
  roundTrip(bond);
  const s = parseDate(settlement);
  const { dates } = schedule(bond, s);
  const c = couponPerPeriod(bond);

  let pv = 0;
  for (const d of dates) {
    const t = dayCountFraction(s, d, bond.dayCount);
    pv += c * discount(t, y, bond.frequency);
  }
  const tM = dayCountFraction(s, parseDate(bond.maturity), bond.dayCount);
  pv += bond.face * discount(tM, y, bond.frequency);
  return pv;
}

/**
 * Accrued interest at `settlement`, per unit of face.
 *
 * Fractional accrual across the coupon period: elapsed fraction of the period multiplied by
 * the coupon for that period. A settlement exactly on a coupon date accrues nothing — the
 * common off-by-one-coupon bug is settling on the coupon date and still charging interest.
 */
export function accruedInterest(bond, settlement) {
  roundTrip(bond);
  const s = parseDate(settlement);
  const { dates, previous } = schedule(bond, s);

  if (daysBetween(previous, s) === 0) return 0;

  let next = dates[0];
  for (const d of dates) {
    if (daysBetween(d, s) > 0) { next = d; break; }
  }

  const elapsed = dayCountFraction(previous, s, bond.dayCount);
  const whole = dayCountFraction(previous, next, bond.dayCount);
  if (whole === 0) throw new RangeError('zero-length coupon period');
  return couponPerPeriod(bond) * (elapsed / whole);
}

/** Clean price = dirty price minus accrued interest. */
export function cleanPrice(bond, y, settlement) {
  return dirtyPrice(bond, y, settlement) - accruedInterest(bond, settlement);
}

/**
 * Yield implied by a dirty price.
 *
 * Bisection, not Newton: the price function is monotone but not everywhere smooth (it has a
 * kink where the next coupon crosses), and Newton on a non-smooth function wanders off the
 * bracket. Bisection cannot leave the bracket, so it cannot return a confident wrong answer.
 *
 * @param bracket [lo, hi] annual yield bounds
 */
export function yieldFromDirtyPrice(bond, price, settlement, bracket = [-0.9, 5]) {
  roundTrip(bond);
  let lo = bracket[0];
  let hi = bracket[1];
  let flo = dirtyPrice(bond, lo, settlement) - price;
  let fhi = dirtyPrice(bond, hi, settlement) - price;

  if (flo < 0 || fhi > 0) {
    throw new RangeError(
      `price ${price} is outside the achievable range at yields [${lo}, ${hi}]: ` +
      `[${dirtyPrice(bond, lo, settlement)}, ${dirtyPrice(bond, hi, settlement)}]`
    );
  }

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = dirtyPrice(bond, mid, settlement) - price;
    if (fm === 0) return mid;
    if (fm > 0) lo = mid; else hi = mid;       // price decreases as yield rises
    if (hi - lo < 1e-14) break;
  }
  return (lo + hi) / 2;
}

/**
 * Sensitivity, by finite difference on a parallel shift.
 *
 * Central rather than one-sided, because a one-sided difference at a coupon date has a kink
 * on one side and not the other and quietly reports a different number depending on which
 * direction the shift went.
 *
 * @param h shift size in absolute yield (1e-4 = 1 basis point)
 */
export function sensitivities(bond, y, settlement, h = 1e-4) {
  const p0 = dirtyPrice(bond, y, settlement);
  const up = dirtyPrice(bond, y + h, settlement);
  const down = dirtyPrice(bond, y - h, settlement);
  return {
    dirtyPrice: p0,
    // Price falls as yield rises, so (down - up) is positive.
    modifiedDuration: (down - up) / (2 * p0 * h),
    convexity: (up + down - 2 * p0) / (p0 * h * h),
  };
}

/** Price change for a one-basis-point parallel shift. */
export const dv01 = (bond, y, settlement) => {
  const s = sensitivities(bond, y, settlement);
  return s.modifiedDuration * s.dirtyPrice * 1e-4;
};
