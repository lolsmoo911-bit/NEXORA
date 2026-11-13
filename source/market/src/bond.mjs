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

import { parseDate, addMonths, dayCountFraction, daysBetween, assertSupportedConvention, icmaDayCountFraction, isLastDayOfMonth } from './daycount.mjs';

/** Serialize a UTC-midnight Date to YYYY-MM-DD for the strict ICMA date gate. */
const isoDate = (d) => d.toISOString().slice(0, 10);

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
  if (b.dayCount === 'ACT/ACT ICMA' && (!Array.isArray(b.referencePeriods) || b.referencePeriods.length === 0)) {
    throw new TypeError('ACT/ACT ICMA requires bond.referencePeriods and frequency');
  }
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
    const isMonthEnd = isLastDayOfMonth(d);
    let previous = addMonths(d, -step, bond.eom || 'limit');
    if (isMonthEnd) {
      previous = new Date(Date.UTC(previous.getUTCFullYear(), previous.getUTCMonth() + 1, 0));
    }
    d = previous;
  }
  dates.reverse();

  if (dates.length === 0) throw new RangeError('maturity is not after settlement');
  if (daysBetween(d, s) < 0) {
    throw new RangeError(`bond has not started accruing by ${settlement}`);
  }
  return { dates, previous: d };
}

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
  const finalEnd = parseDate(supplied[supplied.length - 1].end);
  if (finalEnd.getTime() !== parseDate(bond.maturity).getTime()) {
    throw new RangeError('ACT/ACT ICMA reference schedule must end at bond maturity');
  }
  icmaDayCountFraction(supplied, bond.frequency, supplied[0].start, supplied[supplied.length - 1].end);
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
    return dayCountFraction(isoDate(start), isoDate(end), bond.dayCount, {
      referencePeriods,
      frequency: bond.frequency,
    });
  }
  return dayCountFraction(start, end, bond.dayCount);
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
 * The bracket is an admission policy, not a numerical convenience. Prices are unbounded
 * above as the yield approaches -100%, so an "unreachable price" only exists relative to a
 * stated range. The default is deliberately narrow: a yield below about -50% is not a market
 * reality, and silently solving for one — which an earlier, wider default did — turns a
 * typo into a plausible number.
 *
 * @param bracket [lo, hi] annual yield bounds
 */
export function yieldFromDirtyPrice(bond, price, settlement, bracket = [-0.5, 3]) {
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
