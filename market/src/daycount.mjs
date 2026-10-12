/**
 * Fixed-income date and day-count arithmetic.
 *
 * Everything here is pure: no clock, no network, no locale. Dates are UTC `Date` objects
 * at midnight, and every function is deterministic given its arguments. A pricing core
 * that reads the wall clock cannot be tested against a known value, so nothing in this
 * module reads it.
 *
 * SCOPE, STATED PLAINLY
 * ---------------------
 * Implemented: ACT/365F, ACT/360, 30/360 US (NASD), 30E/360 (Eurobond).
 *
 * NOT implemented, and this matters: ACT/ACT and ACT/ACT ICMA. US Treasuries quote and
 * settle on ACT/ACT, so this module cannot yet price a Treasury note by the market
 * convention. `dayCountFraction` throws on those rather than silently returning ACT/365F,
 * because a wrong day-count basis produces a price that looks entirely normal and is off by
 * a basis point or two on every coupon. Adding ACT/ACT ICMA is the first task after this
 * core is verified.
 *
 * Also absent: business-day calendars (no holiday data), ex-coupon periods, and stub
 * handling for irregular first/last periods. They are listed here rather than left for a
 * reader to discover.
 */

// ------------------------------------------------------------------ date helpers

const MS_DAY = 86400000;

/** Midnight UTC of `y-m-d`. Months are 1-12. Throws on a non-existent date. */
export function ymd(y, m, d) {
  if (m < 1 || m > 12) throw new RangeError(`month out of range: ${m}`);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCDate() !== d) throw new RangeError(`${y}-${m}-${d} does not exist`);
  return dt;
}

export function parseDate(s) {
  if (s instanceof Date) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) throw new TypeError(`expected YYYY-MM-DD, got ${String(s)}`);
  return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
}

export const daysBetween = (a, b) => Math.round((b - a) / MS_DAY);
export const isLastDayOfMonth = (d) => d.getUTCDate() === daysInMonth(d.getUTCFullYear(), d.getUTCMonth() + 1);
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function addDays(d, n) {
  return new Date(d.getTime() + n * MS_DAY);
}

/**
 * Add calendar months, with end-of-month handling.
 *
 * 31 Jan + 1 month is 28 Feb, not 3 March. Month arithmetic that overflows silently
 * produces schedules that drift out of alignment with the contract's actual coupon dates,
 * and a drifted schedule prices a different bond than the one being quoted.
 *
 * @param eom 'none' rolls nothing (31 Jan + 1m -> 3 Mar); 'limit' clamps to month end
 */
export function addMonths(d, n, eom = 'limit') {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const day = d.getUTCDate();
  const dim = daysInMonth(ny, nm);
  if (day <= dim) return ymd(ny, nm, day);
  if (eom === 'limit') return ymd(ny, nm, dim);
  return addDays(ymd(ny, nm, dim), day - dim);
}

// ------------------------------------------------------------------ day counts

/**
 * Year fraction between two dates under a convention.
 *
 * @param convention 'ACT/365F' | 'ACT/360' | '30/360 US' | '30E/360'
 */
export function dayCountFraction(start, end, convention) {
  const a = parseDate(start);
  const b = parseDate(end);
  if (daysBetween(a, b) < 0) throw new RangeError('end precedes start');

  switch (convention) {
    case 'ACT/365F':
      return daysBetween(a, b) / 365;
    case 'ACT/360':
      return daysBetween(a, b) / 360;

    case '30/360 US':
    case '30E/360': {
      let d1 = a.getUTCDate();
      let d2 = b.getUTCDate();
      const y1 = a.getUTCFullYear();
      const y2 = b.getUTCFullYear();
      const m1 = a.getUTCMonth() + 1;
      const m2 = b.getUTCMonth() + 1;

      if (convention === '30E/360') {
        // Every 31st is a 30th; no February exception.
        if (d1 === 31) d1 = 30;
        if (d2 === 31) d2 = 30;
      } else {
        // US NASD: the February exceptions exist because 31 Feb/31 Aug are common coupons.
        const eom1 = isLastDayOfMonth(a);
        const eom2 = isLastDayOfMonth(b);
        if (eom1 && eom2 && a.getUTCMonth() === 1 && b.getUTCMonth() === 1) d2 = 30;
        if (eom2 && a.getUTCMonth() === 1) d2 = 30;
        if (d1 === 31) d1 = 30;
        if (d2 === 31 && d1 >= 30) d2 = 30;
      }
      return (360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1)) / 360;
    }

    default:
      throw new RangeError(`unsupported day-count convention: ${convention}`);
  }
}

/**
 * ACT/ACT (ICMA-style) is not implemented. Saying so loudly is the point: the obvious
 * failure mode of a bond library is to quietly price on 365 when the market uses ACT/ACT,
 * and the resulting price is plausible enough to trade on.
 */
export function assertSupportedConvention(convention) {
  if (!['ACT/365F', 'ACT/360', '30/360 US', '30E/360'].includes(convention)) {
    throw new RangeError(
      `day-count convention ${convention} is not implemented. ` +
      `ACT/ACT is deliberately refused rather than approximated.`
    );
  }
}
