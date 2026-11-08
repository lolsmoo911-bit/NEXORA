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
 * Implemented: ACT/365F, ACT/360, 30/360 US (NASD), 30E/360 (Eurobond), and
 * ACT/ACT ICMA for regular coupons with an explicit reference-period schedule and frequency.
 *
 * NOT implemented: bare ACT/ACT, ACT/ACT ISDA, AFB, irregular ICMA stubs, ex-coupon periods,
 * and business-day calendars. ICMA is not an alias for those other conventions. US Treasuries
 * quote and settle on ACT/ACT; this ICMA increment does not claim Treasury-convention support.
 * A schedule-aware caller must supply actual coupon reference periods; a two-date call
 * deliberately refuses ICMA when those inputs are absent. * Also absent: business-day calendars (no holiday data), ex-coupon periods, and stub
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
 * ACT/ACT ICMA year fraction over an explicit regular coupon reference schedule.
 * Each reference period is a half-open interval [start, end). The fraction is the
 * sum of actual overlap days divided by frequency times actual days in that reference
 * coupon period. Irregular/stub periods are deliberately rejected.
 */
export function icmaDayCountFraction(referencePeriods, frequency, start, end) {
  if (!Array.isArray(referencePeriods) || referencePeriods.length === 0) {
    throw new TypeError('ACT/ACT ICMA requires a non-empty explicit referencePeriods array');
  }
  if (![1, 2, 4].includes(frequency)) {
    throw new RangeError('unsupported ICMA frequency: ' + frequency);
  }

  // ICMA inputs are strict: a bare YYYY-MM-DD string. This is stricter than the generic
  // parser, which still accepts Date objects for the other conventions; the ICMA gate
  // needs strings so a schedule can never smuggle in a time-of-day or an implicit zone.
  const asUtcDate = (value, label) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new TypeError(label + ' must be a YYYY-MM-DD string');
    }
    return parseDate(value);
  };

  // Phase 1: parse every period and require a positive length, so a zero-length or
  // reversed period is reported as exactly that, wherever it sits.
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
    return { start: periodStart, end: periodEnd, days };
  });

  // Phase 2: adjacency, schedule-wide. Every neighbour pair must touch exactly - no gap,
  // no overlap - before any period is judged on its shape. An input whose first real
  // defect is an overlap must never be told "irregular" instead.
  for (let i = 1; i < normalized.length; i++) {
    const delta = daysBetween(normalized[i - 1].end, normalized[i].start);
    if (delta > 0) {
      throw new RangeError('gap of ' + delta + ' day(s) before reference period ' + i);
    }
    if (delta < 0) {
      throw new RangeError('reference period ' + (i - 1) + ' overlaps period ' + i);
    }
  }

  // Phase 3: shape, schedule-wide. Each period spans exactly 12/frequency months and is
  // anchored on the same day of month, or on the last day of BOTH months. One-sided EOM
  // anchors (31 Jan closing to 30 Jul) are stubs and are rejected wherever they sit.
  for (let i = 0; i < normalized.length; i++) {
    const period = normalized[i];
    const monthDelta =
      (period.end.getUTCFullYear() - period.start.getUTCFullYear()) * 12 +
      (period.end.getUTCMonth() - period.start.getUTCMonth());
    const regularDates =
      period.start.getUTCDate() === period.end.getUTCDate() ||
      (isLastDayOfMonth(period.start) && isLastDayOfMonth(period.end));
    if (monthDelta !== 12 / frequency || !regularDates) {
      throw new RangeError(
        'irregular ACT/ACT ICMA reference period ' + i + '; stubs are not supported'
      );
    }
  }

  // Phase 4: the measured interval - ordered, inside schedule coverage, then summed.
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
/**
 * Year fraction between two dates under a convention.
 *
 * @param convention 'ACT/365F' | 'ACT/360' | '30/360 US' | '30E/360'
 */
export function dayCountFraction(start, end, convention, options = {}) {
  const a = parseDate(start);
  const b = parseDate(end);
  if (daysBetween(a, b) < 0) throw new RangeError('end precedes start');

  switch (convention) {
    case 'ACT/ACT ICMA':
      return icmaDayCountFraction(options.referencePeriods, options.frequency, start, end);

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
      // ACT/ACT is the one callers will actually reach for — it is the US Treasury
      // convention — so it is named in the error rather than left in a generic list.
      throw new RangeError(
        `day-count convention "${convention}" is not implemented. ` +
        `ACT/ACT and ACT/ACT ICMA are deliberately refused rather than approximated: ` +
        `a Treasury note priced on 365 instead would be a basis point wrong on every ` +
        `coupon and would look entirely normal.`
      );
  }
}

/**
 * ACT/ACT (ICMA-style) is not implemented. Saying so loudly is the point: the obvious
 * failure mode of a bond library is to quietly price on 365 when the market uses ACT/ACT,
 * and the resulting price is plausible enough to trade on.
 */
export function assertSupportedConvention(convention) {
  if (!['ACT/365F', 'ACT/360', '30/360 US', '30E/360', 'ACT/ACT ICMA'].includes(convention)) {
    throw new RangeError(
      `day-count convention ${convention} is not implemented. ` +
      `Bare ACT/ACT is deliberately refused rather than approximated.`
    );
  }
}
