# Phase 6 — Integration Manifest (workbench only; NOT merged)

Status: isolated integration workbench. Canonical committed sources untouched.
No commit/push to main. No merge proposed until tests and review pass.

## What this workbench proves

- Canonical market (`market/`) untouched; hash-verified unchanged at start.
- This directory has a byte-copy of canonical market (`src/daycount.mjs`, `src/bond.mjs`,
  `test/daycount.test.mjs`, `package.json`) with two isolated increments applied:
  - ACT/ACT ICMA from `workbench/act-act-icma` (regular coupons only, explicit
    `referencePeriods`, strict YYYY-MM-DD strings, no bare ACT/ACT alias).
  - Annual par-yield curve bootstrap from `workbench/curve-bootstrap`.
- Thin adapter `src/adapter.mjs` re-exports the SAME legacy public API names as
  canonical `market/src/bond.mjs` + `market/src/daycount.mjs`, plus
  `bootstrapParCurve` and `icmaDayCountFraction`. Import compatibility with canonical
  legacy functions is tested in `test/adapter.test.mjs`.

## Explicit non-claim

This is NOT integrated into canonical `market/src`. Canonical `market/src/daycount.mjs`
still refuses ACT/ACT ICMA and canonical market has no curve module. A deliberate,
reviewed adapter/merge into `market/` is required before the word "integrated" is used
for the canonical package. See `test/adapter.test.mjs` for the compatibility contract.

## Conventions and guarantees

- Pure functions only; no clock, network, or market-data access.
- Explicit input validation: consecutive `tenorYears 1..n`, finite `parYield > -1`,
  positive bootstrapped DF, non-empty ICMA reference periods, frequency 1/2/4,
  contiguous regular periods.
- Deterministic: no `Math.random`, no dates from system clock.
- No mutation: caller bond/curve inputs deep-checked in tests; curve inputs frozen
  in one test; adapter docs state fresh outputs.
- Scope limits preserved: annual-pay par bonds only for curve; ICMA regular coupons only;
  no stubs/irregulars, ex-coupon, business-day calendars, floating-rate, callable,
  FX/crypto models. Those are NOT in this integration.

## Tests (Node v24.22.1)

Run:
```
cd workbench/phase6-integration && node --test test/*.test.mjs
```
Result: **85/85 pass, 0 fail, exit 0.**
Composition: 41 legacy (base market tests with ICMA-updated legacy assertions),
18 ICMA, 10 curve, 8 cross-module integration, 4 adapter-compatibility, 4
fuzz/property/performance (seeded mulberry32(902024), 500 fuzz curves, bounded
reproducibility report `perf-report.json`).

Additional baseline (captured this session):
- Canonical `market`: 41/41, exit 0.
- Isolated `workbench/act-act-icma`: 59/59, exit 0 (isolated; does not count as integration).
- Isolated `workbench/curve-bootstrap`: 51/51, exit 0 (isolated; does not count as integration).
- `workbench/nexora-scan`: 11/11, exit 0 (separate scaffold; see its README).

## EVM / RPC / gas compatibility (Phase 6 remainder)

- ROADMAP Phase 6 remainder: ACT/ACT ICMA + curve bootstrapping (done here in workbench),
  credit spreads, FX/crypto models, Phase 5 contracts on the live NEXORA chain,
  EVM/RPC compatibility matrix, gas accounting, fuzz, state migration, benchmark.
- This integration does NOT build a chain or RPC. A portable Go 1.25.9 toolchain is
  now present under `workbench/toolchain/go`; it reports `go1.25.9 windows/amd64`.
  WSL is still blocked in the LocalSystem shell (`WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`),
  and no `evmd` binary/live RPC is verified yet. The exact pinned upstream build attempt
  is tracked separately in the ongoing implementation report. Local testnet and Phase 5
  on-chain verification remain BLOCKED until that build and live identity check pass.
- Interface contracts only: `workbench/nexora-scan` implements the read-only RPC
  contract surface (allowlist, rate/size caps, disconnected state) without a live chain.
  No chain ID, genesis, token supply, or deploy was invented from this workbench.

## What is NOT done and must not be claimed

- No security audit, no mainnet readiness, no production chain.
- No Phase 5 contracts executed against a live NEXORA chain in this session.
- Additional code-only models are now in the separate `workbench/phase6-market-models/`
  package: z-spread, FX carry/cross/triangle, deterministic crypto scenarios, a simulation
  reconstruction, and model JSON v1→v2 migration. It has **20/20 tests passing** and a
  local microbenchmark report (`perf-report.json`). These are synthetic pure-model results,
  not EVM/RPC or live market evidence. The simulation is a reconstruction, not historical
  recovery (accessible local Git history did not contain the old engine).
- No canonical `market/` merge; adapters/models remain workbench-local and unreviewed for merge.

## EVM/RPC status update (2026-11-07)

The earlier statements above that local EVM/RPC was wholly blocked are historical and
are superseded by `EVM-LOCAL-VERIFICATION-ADDENDUM.md` and the cross-tract
`workbench/PHASE6-IMPLEMENTATION-REPORT.md`.

A pinned `cosmos/evm v0.7.3` `evmd.exe` was built in `workbench/toolchain` using
portable Go 1.25.9 and Zig/Clang 0.17.1. A deterministic single-validator local testnet
was started on loopback. Live probes verified chain ID `0xdc388`, advancing blocks,
balance, gas estimate, CometBFT status, and one live `NexoraGreeter` deploy/call.
The separate Phase 5 AIdRegistry/AidFactory deployments remain incomplete; four-validator
consensus remains CI-only. The local node is now stopped and all checked ports are closed.
No Cloudflare, DNS, public tunnel, canonical source, or main-branch changes were made.

## Provenance

- Base canonical market hashes (verified unchanged at session start):
  - `src/daycount.mjs` `3E2E0E10...F3BE`, `src/bond.mjs` `40142C5B...BC68`,
    `test/daycount.test.mjs` `DAB218A1...6870`, `package.json` `D0D199F5...0646`.
- Additional model package files: `workbench/phase6-market-models/src/{credit-spread,fx,crypto-scenarios,simulation,state-migration}.mjs`, `src/index.mjs`; tests in `test/*.test.mjs`; benchmark runner `bench/benchmark.mjs` and result `perf-report.json`. Benchmark ran on Windows 11 Pro, Intel Core i5-8500, Node v24.22.1, 25 × 100 samples after 10 warmups; p50/p95 ms/op: curve 0.001328/0.012438, z-spread 2.064133/2.352981, FX forward 0.000441/0.001196, whole simulation 1.618438/1.806515. Synthetic local microbenchmark only, not production/load or chain performance.
- Workbench source files: hashes in `RESTORE-MANIFEST.md` of each source workbench
  (ICMA 59/59, curve 51/51) apply by construction; this integration copies their
  final `src/` and `test/` files verbatim, plus new `test/integration.test.mjs`,
  `test/perf-fuzz.test.mjs`, `test/adapter.test.mjs`, `src/adapter.mjs`.
