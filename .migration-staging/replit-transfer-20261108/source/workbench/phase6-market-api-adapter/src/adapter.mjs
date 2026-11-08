/**
 * Isolated Phase 6 market domain API adapter (workbench only; NOT merged; no UI).
 *
 * Preserves canonical market/src API by re-exporting it unchanged from
 * ../../market/src/*.mjs. Also exposes Phase 6 additions:
 * - ACT/ACT ICMA + annual par-curve bootstrap (workbench/phase6-integration)
 * - credit spreads, FX, crypto scenarios, market simulation, state migration
 *   (workbench/phase6-market-models)
 *
 * Provides a discriminated request/dispatch surface for domain API integration
 * without inventing a frontend. Canonical package remains unchanged.
 */

// Canonical market API (preserved, unchanged source).
export * as canonicalBond from '../../../market/src/bond.mjs';
export * as canonicalDayCount from '../../../market/src/daycount.mjs';
export {
  couponPerPeriod, schedule, dirtyPrice, accruedInterest, cleanPrice,
  yieldFromDirtyPrice, sensitivities, dv01,
} from '../../../market/src/bond.mjs';
export {
  parseDate, addMonths, dayCountFraction, daysBetween, daysInMonth,
  isLastDayOfMonth, addDays, assertSupportedConvention, ymd,
} from '../../../market/src/daycount.mjs';

// Phase 6 integration (legacy-compatible bond/daycount + ICMA + curve bootstrap).
export * as phase6Integration from '../../phase6-integration/src/adapter.mjs';
export { bootstrapParCurve } from '../../phase6-integration/src/curve.mjs';
// Raw ICMA: icmaDayCountFraction(referencePeriods, frequency, start, end)
// ICMA-aware wrapper: phase6Integration.dayCountFraction(from, to, 'ACT/ACT ICMA', { referencePeriods, frequency })
export { icmaDayCountFraction } from '../../phase6-integration/src/daycount.mjs';

// Phase 6 market models (credit/FX/crypto/simulation/state migration).
export * as phase6MarketModels from '../../phase6-market-models/src/index.mjs';
export {
  solveZSpread, dirtyPriceAtZSpread, spreadDuration, fixedBondCashflows, benchmarkDiscountFactor,
} from '../../phase6-market-models/src/credit-spread.mjs';
export {
  fxForwardRate, fxCrossRate, fxTriangleDiagnostic, fxConvert,
} from '../../phase6-market-models/src/fx.mjs';
export {
  cryptoScenarioQuantiles, cryptoShockScenarios,
} from '../../phase6-market-models/src/crypto-scenarios.mjs';
export { runMarketSimulation } from '../../phase6-market-models/src/simulation.mjs';
export { migrateModelState, stableStringify } from '../../phase6-market-models/src/state-migration.mjs';

export { dispatchMarketRequest, MARKET_REQUEST_TYPES } from './dispatch.mjs';
