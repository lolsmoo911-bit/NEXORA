const finite = (x, name) => {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`${name} must be finite`);
};
const positive = (x, name) => { finite(x, name); if (x <= 0) throw new RangeError(`${name} must be positive`); };

/**
 * Deterministic GBM scenario quantiles, not predictions.
 * Assumption: dS/S = mu dt + sigma dW; supplied z-scores are deterministic.
 */
export function cryptoScenarioQuantiles({ spot, annualVolatility, years, annualDrift = 0, zScores = [-2, -1, 0, 1, 2] }) {
  positive(spot, 'spot');
  finite(annualVolatility, 'annualVolatility'); if (annualVolatility < 0) throw new RangeError('annualVolatility cannot be negative');
  finite(years, 'years'); if (years < 0) throw new RangeError('years cannot be negative');
  finite(annualDrift, 'annualDrift');
  if (!Array.isArray(zScores) || zScores.length === 0 || zScores.length > 101) throw new TypeError('zScores must be a non-empty array of at most 101 numbers');
  const variance = annualVolatility * annualVolatility * years;
  const driftTerm = (annualDrift - 0.5 * annualVolatility * annualVolatility) * years;
  return zScores.map((z) => {
    finite(z, 'zScore');
    const price = spot * Math.exp(driftTerm + z * Math.sqrt(variance));
    positive(price, 'scenario price');
    return { zScore: z, price, returnFraction: price / spot - 1 };
  });
}

export function cryptoShockScenarios({ spot, shocks = [-0.8, -0.5, -0.2, 0, 0.2, 0.5, 1] }) {
  positive(spot, 'spot');
  if (!Array.isArray(shocks) || shocks.length === 0) throw new TypeError('shocks must be a non-empty array');
  return shocks.map((shock) => {
    finite(shock, 'shock');
    if (shock <= -1) throw new RangeError('shock must be greater than -1');
    return { shock, scenarioPrice: spot * (1 + shock) };
  });
}
