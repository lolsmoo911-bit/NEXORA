/**
 * Annual par-yield curve bootstrap.
 *
 * SCOPE, STATED PLAINLY
 * ---------------------
 * One narrow model: annual-pay, par-priced fixed-rate bullet bonds, face 100, annual
 * compounding. Node n exists only for tenor n = 1..maxTenor years. Nothing more: no
 * deposits, bills, FRAs, swaps, stubs, day-count conventions, calendars, non-annual
 * coupon frequencies, interpolation, invented intermediate nodes, or market-data access.
 *
 * INPUT CONTRACT
 * --------------
 * One explicitly ordered array of par quotes:
 *   [ { tenorYears: 1, parYield: 0.05 }, { tenorYears: 2, parYield: 0.06 }, ... ]
 * tenorYears must be the consecutive positive integers 1..n starting at 1, in order.
 * No gaps, no duplicates, no reordering - and the function never sorts for the caller.
 * parYield must be a finite number strictly greater than -1.
 *
 * BOOTSTRAP DEFINITION
 * --------------------
 * A par bond of tenor n at par yield c_n prices back to exactly 100:
 *     100 = 100 * c_n * (DF1 + ... + DF(n-1)) + 100 * (1 + c_n) * DFn
 * so, with the earlier annual coupon DFs already bootstrapped:
 *     DFn = (1 - c_n * sum(DF1..DF(n-1))) / (1 + c_n)
 * every node is therefore consistent with every earlier node, and with nothing not
 * stated here. The annual effective zero rate is the standard derivation
 *     z_n = DFn^(-1/n) - 1.
 */

/**
 * Bootstrap discount nodes from ordered annual par quotes.
 *
 * @param {Array<{tenorYears: number, parYield: number}>} parQuotes
 * @returns {Array<{tenorYears: number, parYield: number,
 *                  discountFactor: number, annualEffectiveZeroRate: number}>}
 */
export function bootstrapParCurve(parQuotes) {
  if (!Array.isArray(parQuotes) || parQuotes.length === 0) {
    throw new TypeError(
      'parQuotes must be a non-empty ordered array of { tenorYears, parYield } quotes'
    );
  }

  // Annuity of already-bootstrapped factors at each step (sum DF1..DF(n-1)).
  // Never written to the caller's array; every returned node is a fresh object.
  const nodes = [];
  let annuity = 0;

  for (let i = 0; i < parQuotes.length; i++) {
    const q = parQuotes[i];

    if (!q || typeof q !== 'object' ||
        typeof q.tenorYears !== 'number' || typeof q.parYield !== 'number') {
      throw new TypeError(
        'quote at index ' + i + ' must be an object with numeric tenorYears and parYield'
      );
    }
    if (!Number.isInteger(q.tenorYears) || q.tenorYears !== i + 1) {
      throw new RangeError(
        'tenorYears must be the consecutive positive integers starting at 1 ' +
        '(expected ' + (i + 1) + ', got ' + q.tenorYears + ' at index ' + i +
        '; no gaps, no duplicates, no reordering)'
      );
    }
    if (!Number.isFinite(q.parYield) || q.parYield <= -1) {
      throw new RangeError(
        'parYield at index ' + i + ' must be a finite number greater than -1: got ' +
        q.parYield
      );
    }

    const df = (1 - q.parYield * annuity) / (1 + q.parYield);

    if (!Number.isFinite(df) || df <= 0) {
      throw new RangeError(
        'bootstrapped discount factor at tenor ' + q.tenorYears +
        ' is not a positive finite number: ' + df
      );
    }

    nodes.push({
      tenorYears: i + 1,
      parYield: q.parYield,
      discountFactor: df,
      annualEffectiveZeroRate: Math.pow(df, -1 / (i + 1)) - 1,
    });
    annuity += df;
  }

  return nodes;
}