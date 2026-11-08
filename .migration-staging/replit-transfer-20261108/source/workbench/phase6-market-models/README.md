# NEXORA Phase 6 market-model reconstruction (workbench only)

This package is an isolated, deterministic reconstruction of the missing model layer. The available Git checkout contains only its root clone commit, and the accessible workspace search found Sale/Vesting simulation material but no historical market-simulation engine. This code is therefore a **reconstruction, not a recovered historical implementation**.

## Scope

- Credit: constant continuously compounded z-spread over an annual par curve. Discount factors are log-linearly interpolated in log-DF space. This is not OAS, a hazard-rate model, a rating, or a probability of default.
- FX: spot is quote currency per one base currency. Simple money-market carry is used: F = S(1 + r_quote T)/(1 + r_base T). No live market feed.
- Crypto: deterministic GBM quantiles or explicit stress shocks. Not forecasts or investment advice.
- Simulation: deterministic composition of curve, credit, FX, and crypto inputs; no network, wall clock, or live prices.
- State migration: schema-versioned model/simulation JSON only; not Cosmos/EVM chain state.

## API

- `solveZSpread({ bond, settlement, curveNodes, dirtyPrice, bracket? })`
- `dirtyPriceAtZSpread({ bond, settlement, curveNodes, zSpread })`
- `spreadDuration(args, bump?)`
- `fxForwardRate({ spot, baseRate, quoteRate, yearFraction })`
- `fxCrossRate({ base, cross, quote, crossPerBase, quotePerCross })` (each rate is quote currency per one base unit)
- `fxTriangleDiagnostic({ base, cross, quote, crossPerBase, quotePerCross, quotePerBase, tolerance? })`, `fxConvert({ amount, rate })`
- `cryptoScenarioQuantiles({ spot, annualVolatility, years, annualDrift?, zScores? })`
- `cryptoShockScenarios({ spot, shocks? })`
- `runMarketSimulation(input)`
- `migrateModelState(serialized)`

The existing ICMA/curve implementations are reused from `workbench/phase6-integration`; this package does not modify canonical `market/`.

## Tests

```powershell
node --test test/*.test.mjs
node bench/benchmark.mjs
```

No dependencies beyond Node v24.22.1 built-ins.
