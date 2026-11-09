# Phase 6 Market Model Reconstruction — implementation report

Date: 2026-11-06 (Africa/Algiers)
Status: **code-only model slice implemented and tested in isolated workbench; Phase 6 overall remains IN PROGRESS.**

## Delivered

- Credit z-spread pricing and solver, spread duration, and cashflow generation based on the existing regular fixed-rate bond schedule API.
- FX spot/base-quote convention, simple money-market carry forwards, cross rates, triangle consistency diagnostic, and currency conversion.
- Deterministic crypto GBM quantile stress scenarios and deterministic proportional shocks.
- Market Simulation reconstruction composing curve bootstrap, credit z-spread, FX and crypto scenario outputs.
- Versioned model-state migration v1 -> v2; corrupt JSON and unsupported future versions rejected.
- Public API barrel, tests, README, machine-specific benchmark report.

## Validation

Command:
`node --test test/*.test.mjs`

Result: **20/20 pass, 0 fail, exit 0** (Node v24.22.1).

Property checks use fixed PRNG seeds and 150 iterations per family. Regression and boundary tests cover solver round-trip, monotonic spread pricing, FX carry/triangle, positive crypto scenarios, deterministic simulation, mutation safety, and schema migration.

Benchmark:
`node bench/benchmark.mjs`

Result saved to `perf-report.json`. Captured on Windows 11 Pro / x64, Intel Core i5-8500 @ 3.00GHz (6 logical CPUs, 15.78 GiB RAM), Node v24.22.1. Warm-up 10; 25 independent samples; 100 operations/sample; p50/p95 per-operation (ms):

| Operation | p50 ms/op | p95 ms/op |
|---|---:|---:|
| Annual par curve bootstrap (10 nodes) | 0.000991 | 0.009953 |
| Credit Z-spread solve | 1.526136 | 1.767900 |
| FX forward | 0.000221 | 0.000891 |
| Whole model simulation | 1.681566 | 1.891244 |

These are environment-specific local microbenchmarks over deterministic synthetic inputs, not network, production, security, or live market results.

## Market Simulation provenance

The accessible local Git metadata exposes only the restored root clone commit; its accessible history does not contain an older market-simulation engine. Searches in the checked-out sources and preserved restore staging found token-sale/vesting simulations, which are distinct from a fixed-income/FX/crypto market simulation. This runner is therefore a **new reconstruction**, not a verbatim historical recovery.

## Explicit assumptions and limits

- Credit spread is a constant continuously compounded Z-spread over the benchmark discount curve, interpolated log-linearly in discount-factor space. It is not OAS, a hazard-rate model, default probability, or rating.
- FX rates quote units of quote currency per one unit of base currency. Forward rates use simple money-market carry, not a full collateralized curve/CSA framework.
- Crypto outputs are deterministic GBM quantiles or specified stress shocks, not price forecasts or investment advice.
- The simulation uses explicit caller-supplied inputs only. It has no live market data, clock, or network dependencies.
- State migration applies only to this workbench's JSON model/simulation state, never Cosmos/EVM chain state or testnet ledgers.
- ICMA and curve bootstrap are reused from `workbench/phase6-integration`; canonical `market/` remains unchanged.

## Cross-workbench EVM/RPC update (2026-11-07)

The EVM/RPC tasks that were previously listed as wholly outstanding were subsequently
advanced in the parallel local-testnet tract. See
`workbench/PHASE6-IMPLEMENTATION-REPORT.md`,
`workbench/evm-compat/observations-2026-11-07.json`, and
`workbench/phase6-integration/EVM-LOCAL-VERIFICATION-ADDENDUM.md`.

The pinned `cosmos/evm v0.7.3` runtime was built with portable Go 1.25.9 + Zig/Clang,
and a one-validator loopback testnet returned live `eth_chainId=0xdc388`, advancing
blocks, a test balance, gas estimate, and a successful `NexoraGreeter` deployment
and call. The node is now stopped. This does not verify four-validator consensus or
all Phase 5 contracts: `AIdRegistry` / `AidFactory` are still not deployed on this
local chain. The EVM/RPC matrix and observed gas data are recorded separately.

Still outstanding for Phase 6:
- Deploy and exercise `AIdRegistry` / `AidFactory` (+ required dependents) on the isolated
  local NEXORA chain, then run their read/write/query flows and capture receipts.
- Re-run the four-validator consensus/recovery drill locally (currently CI-verified only).
- Complete compatibility/fuzz/state migration requirements for chain state, beyond the
  model-state migration harness here.
- Complete independent review and resolve any critical/high findings. No security review
  or audit is claimed.
- Review and deliberately integrate the market-model/ICMA/curve workbenches into the
  canonical `market/` package; no merge has been proposed or performed.

## Isolation and governance

All files in this package live under `workbench/phase6-market-models`. No tracked `market/` source, existing phase6 integration workbench, scanner, Cloudflare configuration, chain runtime, or testnet state/ledger was changed. No commit, push, or merge was made.
