# Phase 6 Market Domain API Adapter — Integration Contract (workbench)

**Status:** isolated workbench adapter, 2026-11-07. **No UI/frontend found in source** (`testnet/` contains only `state.json`/`ledger.json`, not UI; `workbench/nexora-scan` is a read-only chain explorer, not a market UI/API). This adapter is a *domain API* composition layer; it does **not** fabricate UI integration. Canonical `market/` is unchanged.

## Gap (exact)
- Canonical `market/` exposes bond/daycount pricing modules only (`src/bond.mjs`, `src/daycount.mjs`, tests 41/41) with no HTTP/server/UI/dashboard entrypoint.
- Phase 6 additions exist in workbench packages but were not wired into one stable domain API surface consumable by a future market API/UI: `workbench/phase6-integration` (ACT/ACT ICMA, annual par-curve bootstrap, legacy-compatible adapter, 85 tests) and `workbench/phase6-market-models` (credit spreads, FX, crypto scenarios, simulation reconstruction, state migration, 20 tests).
- No located market UI/API server in project source (outside toolchain noise). Any HTTP/UI integration remains future work and must preserve these contracts.

## Adapter (`src/adapter.mjs`, `src/dispatch.mjs`)
- **Preserves canonical market API:** re-exports `market/src/bond.mjs` and `market/src/daycount.mjs` unchanged (same function references) and exposes them under `canonicalBond`/`canonicalDayCount` namespaces.
- **Adds/wires:** ACT/ACT ICMA (`icmaDayCountFraction` / ICMA-aware daycount via phase6-integration), `bootstrapParCurve`, credit (`solveZSpread`, `dirtyPriceAtZSpread`, `spreadDuration`, `fixedBondCashflows`, `benchmarkDiscountFactor`), FX (`fxForwardRate`, `fxCrossRate`, `fxTriangleDiagnostic`, `fxConvert`), crypto (`cryptoScenarioQuantiles`, `cryptoShockScenarios`), simulation (`runMarketSimulation`), migration (`migrateModelState`, `stableStringify`).
- **Discriminated API:** `dispatchMarketRequest({ type, payload }) -> {ok,type,result}|{ok,type,error}` with `MARKET_REQUEST_TYPES` covering legacy bond/daycount, ICMA, curve, credit, FX, crypto, simulation, state migration. Pure, deterministic, no network/UI.
- **Non-claims:** no canonical merge, no security audit, no mainnet readiness, simulation is a reconstruction (per phase6-market-models).

## Required suite evidence
Run from `C:\Users\Administrator\NEXORA-ANEX-REBUILT\source`:
- `cd market; node --test test/*.test.mjs` (canonical, 41 expected)
- `cd workbench/phase6-integration; node --test test/*.test.mjs` (85 expected)
- `cd workbench/phase6-market-models; node --test test/*.test.mjs` (20 expected)
- `cd workbench/phase6-market-api-adapter; node --test test/*.test.mjs` (adapter contract/integration)
Record counts and exit codes in session evidence.
