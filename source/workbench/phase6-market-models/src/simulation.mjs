import { bootstrapParCurve } from '../../phase6-integration/src/curve.mjs';
import { dirtyPriceAtZSpread, solveZSpread, spreadDuration } from './credit-spread.mjs';
import { fxForwardRate, fxTriangleDiagnostic } from './fx.mjs';
import { cryptoScenarioQuantiles, cryptoShockScenarios } from './crypto-scenarios.mjs';

function assertObject(x, name) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new TypeError(`${name} must be an object`);
}

/** Deterministic orchestrator. No market feeds, wall-clock calls, or implicit inputs. */
export function runMarketSimulation(input) {
  assertObject(input, 'input');
  assertObject(input.bond, 'bond');
  assertObject(input.fx, 'fx');
  assertObject(input.crypto, 'crypto');
  const curveNodes = bootstrapParCurve(input.parQuotes);
  const zSpread = input.bond.dirtyPrice === undefined
    ? null
    : solveZSpread({
        bond: input.bond.instrument,
        settlement: input.bond.settlement,
        curveNodes,
        dirtyPrice: input.bond.dirtyPrice,
      });
  const spread = zSpread === null ? null : {
    zSpread,
    spreadDuration: spreadDuration({
      bond: input.bond.instrument,
      settlement: input.bond.settlement,
      curveNodes,
      zSpread,
    }),
    repricedDirtyPrice: dirtyPriceAtZSpread({
      bond: input.bond.instrument,
      settlement: input.bond.settlement,
      curveNodes,
      zSpread,
    }),
  };
  const fxForward = fxForwardRate(input.fx);
  const fxTriangle = input.fx.triangle
    ? fxTriangleDiagnostic(input.fx.triangle)
    : null;
  const crypto = input.crypto.shocks
    ? cryptoShockScenarios({ spot: input.crypto.spot, shocks: input.crypto.shocks })
    : cryptoScenarioQuantiles(input.crypto);
  return {
    schemaVersion: 1,
    assumptions: {
      curve: 'annual-pay par curve, annual-effective zero rates, log-linear discount-factor interpolation in credit spread module',
      creditSpread: 'constant continuously-compounded z-spread, not OAS or default probability',
      fx: 'base/quote spot convention and simple money-market carry',
      crypto: input.crypto.shocks ? 'deterministic spot shocks, not forecasts' : 'deterministic GBM quantiles, not forecasts',
    },
    outputs: { curveNodes, creditSpread: spread, fxForward, fxTriangle, crypto },
  };
}
