# Phase 6 Market Domain API Adapter (workbench)

Isolated domain API composition layer (`workbench/phase6-market-api-adapter/`). **No UI/frontend found in source**; this does not invent a frontend or HTTP server. Canonical `market/` is unchanged.

## What it provides
- **Preserves canonical market API**: re-exports `market/src/bond.mjs` and `market/src/daycount.mjs` (same function references) plus `canonicalBond`/`canonicalDayCount` namespaces.
- **Wires Phase 6 additions**: ACT/ACT ICMA + annual par-curve bootstrap (`phase6-integration`), credit spreads, FX, crypto scenarios, market simulation reconstruction, state migration (`phase6-market-models`).
- **Discriminated dispatch** (`dispatchMarketRequest({type,payload}) -> {ok,type,result}|{ok,type,error}`) for stable domain API integration.

## Supported request schemas (examples)

| Type | Payload (valid) | Notes |
|---|---|---|
| `market.legacy.dayCountFraction` | `{ from, to, convention }` | canonical daycount |
| `market.legacy.bond.dirtyPrice` | `{ bond, y, settlement }` | canonical bond |
| `market.legacy.bond.cleanPrice` | `{ bond, y, settlement }` |  |
| `market.legacy.bond.yieldFromDirtyPrice` | `{ bond, price, settlement, bracket? }` |  |
| `market.legacy.bond.accruedInterest` | `{ bond, settlement }` |  |
| `market.legacy.bond.sensitivities` | `{ bond, y, settlement, h? }` |  |
| `market.actActIcma.dayCountFraction` | `{ from, to, convention:'ACT/ACT ICMA', opts:{ referencePeriods, frequency } }` | uses ICMA-aware `dayCountFraction` wrapper |
| `market.curve.bootstrapPar` | `{ parQuotes:[{tenorYears,parYield},...] }` | annual par curve |
| `market.credit.solveZSpread` | `{ bond, settlement, curveNodes, dirtyPrice, bracket? }` | object contract |
| `market.credit.dirtyPriceAtZSpread` | `{ bond, settlement, curveNodes, zSpread }` |  |
| `market.credit.spreadDuration` | `{ bond, settlement, curveNodes, zSpread, bump? }` |  |
| `market.credit.fixedBondCashflows` | `{ bond, settlement }` |  |
| `market.fx.forwardRate` | `{ spot, baseRate, quoteRate, yearFraction }` | exact model fields |
| `market.fx.crossRate` | `{ base, cross, quote, crossPerBase, quotePerCross }` |  |
| `market.fx.triangleDiagnostic` | `{ base, cross, quote, crossPerBase, quotePerCross, quotePerBase, tolerance? }` |  |
| `market.fx.convert` | `{ amount, rate }` |  |
| `market.crypto.scenarioQuantiles` | `{ spot, annualVolatility, years, annualDrift?, zScores? }` |  |
| `market.crypto.shockScenarios` | `{ spot, shocks? }` |  |
| `market.simulation.run` | `{ input }` or direct simulation input | requires `parQuotes`, `bond` (with `instrument`, `settlement`, optional `dirtyPrice`), `fx` (`spot,baseRate,quoteRate,yearFraction`), `crypto` (`spot,annualVolatility,years` or shocks) |
| `market.state.migrate` | `{ serialized }` (JSON string) | `migrateModelState` requires serialized JSON with integer `version`, `scenarioId`, `inputs`; returns migrated JSON string (v2 shape) — dispatch passes through |

**Direct ICMA export:** `icmaDayCountFraction(referencePeriods, frequency, start, end)` (raw phase6-integration signature). **ICMA-aware wrapper:** `phase6Integration.dayCountFraction(from,to,'ACT/ACT ICMA',{referencePeriods,frequency})`.

Malformed/invalid payloads return `{ ok:false, type, error:{name,message} }`.

## Test evidence (2026-11-07, rerun)
- Canonical `market`: **41 tests, 41 pass, 0 fail, exit 0** (`node --test test/*.test.mjs`)
- `workbench/phase6-integration`: **85 tests, 85 pass, 0 fail, exit 0**
- `workbench/phase6-market-models`: **20 tests, 20 pass, 0 fail, exit 0**
- `workbench/phase6-market-api-adapter`: **6 tests, 6 pass, 0 fail, exit 0** — verifies canonical legacy export identity preservation, ICMA raw `(referencePeriods,frequency,start,end)` + ICMA-aware wrapper dispatch, curve/credit/FX/crypto/simulation/migration exports, and discriminated dispatch for all 20 request types with valid fixtures plus representative malformed/error cases (including `market.simulation.run` with required `parQuotes,bond,fx,crypto` and `fx` fields `spot,baseRate,quoteRate,yearFraction`; `market.state.migrate` via serialized JSON string).

## CI 4-validator reproduction
See `../PHASE3-4VALIDATOR-CI-REPRO-PLAN.md` (Phase 3 CI passed historically; local 4-validator **not run** on this Windows/LocalSystem host — C3).

## Non-claims
Workbench-only, no canonical merge, no security audit, no mainnet/production readiness. Market simulation is a reconstruction (not recovered historical code). No public RPC/tunnel/DNS changes.