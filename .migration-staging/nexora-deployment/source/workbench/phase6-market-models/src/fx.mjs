const finite = (x, name) => {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`${name} must be finite`);
};
const positive = (x, name) => { finite(x, name); if (x <= 0) throw new RangeError(`${name} must be positive`); };
const currency = (x, name) => {
  if (typeof x !== 'string' || !/^[A-Z]{3}$/.test(x)) throw new TypeError(`${name} must be a 3-letter uppercase currency code`);
};

/** Spot quote convention: units of quote currency for one unit of base currency. */
export function fxForwardRate({ spot, baseRate, quoteRate, yearFraction }) {
  positive(spot, 'spot'); finite(baseRate, 'baseRate'); finite(quoteRate, 'quoteRate');
  finite(yearFraction, 'yearFraction');
  if (yearFraction < 0) throw new RangeError('yearFraction cannot be negative');
  if (1 + baseRate * yearFraction <= 0 || 1 + quoteRate * yearFraction <= 0) {
    throw new RangeError('simple money-market accumulation factors must be positive');
  }
  return spot * (1 + quoteRate * yearFraction) / (1 + baseRate * yearFraction);
}

export function fxCrossRate({ base, cross, quote, crossPerBase, quotePerCross }) {
  currency(base, 'base'); currency(cross, 'cross'); currency(quote, 'quote');
  if (new Set([base, cross, quote]).size !== 3) throw new RangeError('base, cross and quote currencies must differ');
  positive(crossPerBase, 'crossPerBase'); positive(quotePerCross, 'quotePerCross');
  return { pair: `${base}/${quote}`, quotePerBase: crossPerBase * quotePerCross };
}

export function fxTriangleDiagnostic({ base, cross, quote, crossPerBase, quotePerCross, quotePerBase, tolerance = 1e-8 }) {
  currency(base, 'base'); currency(cross, 'cross'); currency(quote, 'quote');
  positive(crossPerBase, 'crossPerBase'); positive(quotePerCross, 'quotePerCross');
  positive(quotePerBase, 'quotePerBase'); positive(tolerance, 'tolerance');
  const implied = crossPerBase * quotePerCross;
  const relativeDeviation = Math.abs(implied - quotePerBase) / quotePerBase;
  return { impliedQuotePerBase: implied, observedQuotePerBase: quotePerBase, relativeDeviation, consistent: relativeDeviation <= tolerance };
}

export function fxConvert({ amount, rate }) {
  finite(amount, 'amount'); positive(rate, 'rate');
  return amount * rate;
}
