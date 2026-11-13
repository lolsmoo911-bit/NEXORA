import { schedule, couponPerPeriod } from './bond.mjs';
import { dayCountFraction } from './daycount.mjs';

const finite = (x, label) => {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`${label} must be finite`);
};
const positive = (x, label) => { finite(x, label); if (x <= 0) throw new RangeError(`${label} must be positive`); };

function validateCurve(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new TypeError('curveNodes must be a non-empty array');
  let previous = 0;
  for (const [i, n] of nodes.entries()) {
    if (!n || !Number.isInteger(n.tenorYears) || n.tenorYears !== i + 1) {
      throw new RangeError('curveNodes must have consecutive integer tenors starting at 1');
    }
    positive(n.discountFactor, `curveNodes[${i}].discountFactor`);
    if (n.discountFactor > 1.5) throw new RangeError('discount factor is outside the supported range');
    previous = n.tenorYears;
  }
  return previous;
}

// Log-linear interpolation/extrapolation of discount factors in continuously compounded
// zero-rate space. At t=0, DF=1. Beyond the final node, this model refuses extrapolation.
export function benchmarkDiscountFactor(curveNodes, timeYears) {
  const maxTenor = validateCurve(curveNodes);
  finite(timeYears, 'timeYears');
  if (timeYears < 0 || timeYears > maxTenor) throw new RangeError('timeYears outside curve coverage');
  if (timeYears === 0) return 1;
  const lowerTenor = Math.floor(timeYears);
  const upperTenor = Math.ceil(timeYears);
  const logDf = (t) => t === 0 ? 0 : Math.log(curveNodes[t - 1].discountFactor);
  if (lowerTenor === upperTenor) return Math.exp(logDf(lowerTenor));
  const w = timeYears - lowerTenor;
  return Math.exp(logDf(lowerTenor) * (1 - w) + logDf(upperTenor) * w);
}

export function fixedBondCashflows(bond, settlement) {
  if (!bond || typeof bond !== 'object') throw new TypeError('bond must be an object');
  const { dates } = schedule(bond, settlement);
  const coupon = couponPerPeriod(bond);
  return dates.map((date, i) => ({
    date: date.toISOString().slice(0, 10),
    amount: coupon + (i === dates.length - 1 ? bond.face : 0),
  }));
}

function yearFraction(bond, settlement, date) {
  return dayCountFraction(settlement, date, bond.dayCount, {
    referencePeriods: bond.referencePeriods,
    frequency: bond.frequency,
  });
}

export function dirtyPriceAtZSpread({ bond, settlement, curveNodes, zSpread }) {
  finite(zSpread, 'zSpread');
  const cashflows = fixedBondCashflows(bond, settlement);
  let pv = 0;
  for (const cf of cashflows) {
    const t = yearFraction(bond, settlement, cf.date);
    const df = benchmarkDiscountFactor(curveNodes, t) * Math.exp(-zSpread * t);
    positive(df, 'spread-adjusted discount factor');
    pv += cf.amount * df;
  }
  return pv;
}

/**
 * Solve a continuously-compounded z-spread over a log-linearly interpolated benchmark DF
 * curve. This is a simple constant spread measure, not OAS, hazard-rate spread or rating.
 */
export function solveZSpread({ bond, settlement, curveNodes, dirtyPrice, bracket = [-0.25, 2], tolerance = 1e-12 }) {
  positive(dirtyPrice, 'dirtyPrice');
  if (!Array.isArray(bracket) || bracket.length !== 2) throw new TypeError('bracket must be [low, high]');
  let [lo, hi] = bracket;
  finite(lo, 'bracket low'); finite(hi, 'bracket high'); positive(tolerance, 'tolerance');
  if (!(lo < hi)) throw new RangeError('bracket low must be less than high');
  let fLo = dirtyPriceAtZSpread({ bond, settlement, curveNodes, zSpread: lo }) - dirtyPrice;
  let fHi = dirtyPriceAtZSpread({ bond, settlement, curveNodes, zSpread: hi }) - dirtyPrice;
  if (fLo < 0 || fHi > 0) throw new RangeError('dirtyPrice is outside the z-spread bracket');
  for (let i = 0; i < 240; i++) {
    const mid = (lo + hi) / 2;
    const fMid = dirtyPriceAtZSpread({ bond, settlement, curveNodes, zSpread: mid }) - dirtyPrice;
    if (Math.abs(fMid) <= tolerance || hi - lo <= tolerance) return mid;
    if (fMid > 0) lo = mid; else hi = mid;
  }
  throw new RangeError('z-spread solver did not converge');
}

export function spreadDuration(args, bump = 1e-4) {
  positive(bump, 'bump');
  const p0 = dirtyPriceAtZSpread({ ...args, zSpread: args.zSpread });
  const up = dirtyPriceAtZSpread({ ...args, zSpread: args.zSpread + bump });
  const down = dirtyPriceAtZSpread({ ...args, zSpread: args.zSpread - bump });
  return (down - up) / (2 * p0 * bump);
}
