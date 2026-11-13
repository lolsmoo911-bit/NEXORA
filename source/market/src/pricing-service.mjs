import { bootstrapParCurve } from './curve.mjs';
import { dirtyPriceAtZSpread, solveZSpread, spreadDuration } from './credit-spread.mjs';
import { fxConvert, fxCrossRate, fxForwardRate, fxTriangleDiagnostic } from './fx.mjs';
import { cryptoScenarioQuantiles, cryptoShockScenarios } from './crypto-scenarios.mjs';
import { runMarketSimulation } from './simulation.mjs';

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

function assertFinite(x, name) {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`${name} must be finite`);
}

export function normalizeOracleFeed(feed, { requireFresh = false, requireExists = true } = {}) {
  if (!isObj(feed)) throw new TypeError('feed must be an object');
  const { price, decimals, updatedAt, isFresh, exists, sourceRef } = feed;
  if (requireExists && exists === false) throw new RangeError('feed does not exist');
  if (exists === false) return null;
  if (requireFresh && isFresh === false) throw new RangeError('feed is stale');
  if (typeof price !== 'bigint' && (typeof price !== 'number' || !Number.isFinite(price))) {
    // allow integer-like numeric or bigint-as-number not expected; prefer number/bigint-safe handling
  }
  let p;
  if (typeof price === 'bigint') p = Number(price);
  else p = price;
  assertFinite(p, 'feed.price');
  const d = decimals ?? 0;
  if (!Number.isInteger(d) || d < 0 || d > 36) throw new RangeError('feed.decimals must be an integer between 0 and 36');
  const scale = 10 ** d;
  const value = p / scale;
  assertFinite(value, 'normalized feed value');
  return {
    value,
    rawPrice: price,
    decimals: d,
    updatedAt: updatedAt ?? null,
    isFresh: isFresh ?? null,
    exists: exists ?? true,
    sourceRef: sourceRef ?? null,
  };
}

export function valueBondScenario(input) {
  if (!isObj(input)) throw new TypeError('input must be an object');
  const { instrument, settlement, parQuotes, dirtyPrice, zSpread } = input;
  if (!instrument || !isObj(instrument)) throw new TypeError('instrument must be an object');
  if (typeof settlement !== 'string') throw new TypeError('settlement must be a string date');
  let curveNodes = null;
  if (parQuotes !== undefined) {
    curveNodes = bootstrapParCurve(parQuotes);
  } else if (Array.isArray(input.curveNodes)) {
    curveNodes = input.curveNodes;
  }

  const result = { kind: 'bond', instrument, settlement, curveNodes };
  if (dirtyPrice != null && curveNodes) {
    const solved = solveZSpread({ bond: instrument, settlement, curveNodes, dirtyPrice });
    result.creditSpread = {
      zSpread: solved,
      spreadDuration: spreadDuration({ bond: instrument, settlement, curveNodes, zSpread: solved }),
      repricedDirtyPrice: dirtyPriceAtZSpread({ bond: instrument, settlement, curveNodes, zSpread: solved }),
      marketDirtyPrice: dirtyPrice,
    };
  } else if (zSpread != null && curveNodes) {
    assertFinite(zSpread, 'zSpread');
    result.creditSpread = {
      zSpread,
      spreadDuration: spreadDuration({ bond: instrument, settlement, curveNodes, zSpread }),
      repricedDirtyPrice: dirtyPriceAtZSpread({ bond: instrument, settlement, curveNodes, zSpread }),
      marketDirtyPrice: null,
    };
  } else {
    result.creditSpread = null;
  }
  return result;
}

export function valueFx(input) {
  if (!isObj(input)) throw new TypeError('input must be an object');
  let spot = input.spot;
  let spotFeed = null;
  if (input.spotFeed != null) {
    spotFeed = normalizeOracleFeed(input.spotFeed, { requireFresh: input.requireFreshSpot === true, requireExists: true });
    spot = spotFeed.value;
  }
  const out = { kind: 'fx', spot, spotFeed };
  if (input.baseRate != null || input.quoteRate != null || input.yearFraction != null) {
    out.forward = fxForwardRate({ spot, baseRate: input.baseRate, quoteRate: input.quoteRate, yearFraction: input.yearFraction });
  }
  if (input.cross != null) {
    out.cross = fxCrossRate(input.cross);
  }
  if (input.triangle != null) {
    out.triangle = fxTriangleDiagnostic(input.triangle);
  }
  if (input.convert != null) {
    out.converted = fxConvert({ amount: input.convert.amount, rate: input.convert.rate ?? spot });
  }
  return out;
}

export function valueCrypto(input) {
  if (!isObj(input)) throw new TypeError('input must be an object');
  let spot = input.spot;
  let spotFeed = null;
  if (input.spotFeed != null) {
    spotFeed = normalizeOracleFeed(input.spotFeed, { requireFresh: input.requireFreshSpot === true, requireExists: true });
    spot = spotFeed.value;
  }
  const base = { ...input, spot };
  if (spotFeed) base.spotFeed = spotFeed;
  if (Array.isArray(input.shocks)) {
    return { kind: 'crypto', mode: 'shocks', spot, spotFeed, scenarios: cryptoShockScenarios({ spot, shocks: input.shocks }) };
  }
  return { kind: 'crypto', mode: 'quantiles', spot, spotFeed, scenarios: cryptoScenarioQuantiles(base) };
}

export function valueMarketScenario(input) {
  if (!isObj(input)) throw new TypeError('input must be an object');
  // Allow optional oracle-normalized spot injection for fx/crypto without mutating caller intent unexpectedly
  const normalized = structuredClone(input);
  if (normalized.fx?.spotFeed != null) {
    normalized.fx.spot = normalizeOracleFeed(normalized.fx.spotFeed, { requireFresh: normalized.fx.requireFreshSpot === true }).value;
    delete normalized.fx.spotFeed;
    delete normalized.fx.requireFreshSpot;
  }
  if (normalized.crypto?.spotFeed != null) {
    normalized.crypto.spot = normalizeOracleFeed(normalized.crypto.spotFeed, { requireFresh: normalized.crypto.requireFreshSpot === true }).value;
    delete normalized.crypto.spotFeed;
    delete normalized.crypto.requireFreshSpot;
  }
  const simulation = runMarketSimulation(normalized);
  return { kind: 'market-scenario', ...simulation };
}

export function priceAsset(request) {
  if (!isObj(request)) throw new TypeError('request must be an object');
  const type = request.assetType || request.kind || request.type;
  switch (type) {
    case 'bond':
    case 'fixed-income':
      return valueBondScenario(request);
    case 'fx':
      return valueFx(request);
    case 'crypto':
      return valueCrypto(request);
    case 'market':
    case 'scenario':
    case 'market-scenario':
      return valueMarketScenario(request);
    default:
      throw new TypeError(`unsupported assetType: ${String(type)}`);
  }
}
