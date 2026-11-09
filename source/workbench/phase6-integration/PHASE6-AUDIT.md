# Phase 1–5 gate audit + Phase 6 manifest (workbench, cross-phase)

Session date: 2026-11-06 (Africa/Algiers). All evidence below was inspected in this session;
nothing is marked ready merely because a report says COMPLETE. Local node path is
`C:\Program Files\nodejs\node.exe` v24.22.1.

## Governance / provenance finding (MUST READ)

Two unrelated phase systems live in two directories. Both were preserved untouched.

- **Parent governance workspace** `C:\Users\Administrator\NEXORA-ANEX-REBUILT`
  (files: `README.md`, `docs/FOUNDATION-ARCHITECTURE-v1.md`, `docs/PROJECT-PLAN.md`,
  `docs/STATUS.md`, `docs/WORK-QUEUE.md`, `docs/DECISION-LOG.md`, `apps/market-data-hub/`):
  product baseline = multi-asset financial-data platform; Phases 0–5 = Foundation →
  Market Data MVP → Portfolio → Cosmos Chain+Oracle → Digital Asset Pilot → Regulated
  Integrations. STATUS claims "no chain source, no chain build, no chain test is
  verified"; WSL blocked; Python 3.13.7; decisions D-001…D-008 OPEN. Decisions are
  tracked; ANEX supply/tokenomics UNDECIDED; no host validator network claimed.

- **GitHub code clone** `C:\Users\Administrator\NEXORA-ANEX-REBUILT\source`
  (HEAD `863cd4ddc06a61375ccc56d30ed9a8f4501873bf`, branch `main`, remote
  `https://github.com/lolsmoo911-bit/NEXORA`): chain Phases 1–6 = unmodified reference
  chain → NEXORA devnet config → 4-validator devnet+recovery → AID spec/impl →
  registry+CREATE2 → market simulation core + compatibility. The clone contains a real
  chain pipeline, 135 tracked files, 7 Solidity contracts, and GitHub Actions evidence.
  It is also the same Testnet project described by `source/README.md`,
  `source/ROADMAP.md`, `source/docs/STATUS.md` ("single source of truth" at `f9a0a5d`).

**Report of mismatch:** the parent governs a DIFFERENT phase model than the clone.
The parent's "Phase 1–5 are blocked / no chain" and the clone's "Phases 1–5 COMPLETE,
Phase 6 IN PROGRESS" cannot both be the phase system. This audit uses ONLY the clone's
`source/ROADMAP.md` phase definitions (the user's task explicitly targets the canonical
GitHub clone). The parent baseline was preserved and NOT reconciled into the clone;
any phase-readiness claim must state which baseline it follows. No file in either
tree was overwritten.

Also recorded: **remote main `7483c66d4ac7ab92b7d27248d82c6ce615f95fad`** (one epoch
newer than local HEAD `863cd4d` per GitHub connector) has only scheduled
`testnet/ledger.json` and `testnet/state.json` updates as its content delta. This
session did NOT reset, rewrite, or copy that state; the local clone remains at its
verified `863cd4d` HEAD for a clean evidence baseline.

## HEAD / chronology

- Local HEAD verified this session: `863cd4ddc06a61375ccc56d30ed9a8f4501873bf` (matches
  the known previous HEAD).
- `status --short --branch`: `## main...origin/main` + `?? workbench/` (tracked tree clean).
- Recent non-testnet history includes the Phase 1–5 close commits and the later
  vanity/fee/endpoint batches; the post-epoch-580 commits are testnet-epoch state updates
  only. The clone is one epoch BEHIND remote main (`7483c66d`) and that gap is
  state/ledger-only; it is not a code delta to reconcile into workbench work.
- Legacy/restore-staging archives: `source/workbench/{act-act-icma,curve-bootstrap,recovery-tools}`
  (untracked), `git-history-clone.restore-staging` lives in the PARENT workspace, and
  the legacy `logs/` of `E:\NEXORA-ANEX-REBUILT` (10 files, hash-verified per parent
  `docs/LEGACY-MIGRATION-REPORT.md`). None are canonical source; they are preserved
  originals and must not be copied into `market/` as-is without review.

## Evidence matrix — Phases 1–5 (clone ROADMAP)

Each was cross-checked against source, tests, workflows, and CI links. "Pure JS
run locally" = Node-only suites re-executed here; Chain phases required CI artifacts
because this host has no Go/Foundry/docker.

| Phase | Claimed | Implementation path | Runnable artifact (this session) | Pass/Fail/Blocked | Unresolved / decision-required |
|---|---|---|---|---|---|
| 1 — Unmodified reference chain | COMPLETE, run #38016004413 `success` | `ci/verify-reference-chain.sh`, `contracts/src/NexoraGreeter.sol`, pinned upstream c3ae9067 (cosmos/evm v0.7.3) | CI link only (no local Go/Foundry to re-run). Workflow: `.github/workflows/phase1-reference-verify.yml` | **PASS by CI evidence; locally BLOCKED** | Release Family 2026.1 gap open (ADR/`chain/upstream.md`); Sherlock 2025-07-28 audit predates v0.7.3 ~14mo — NOT an audit of this pin. |
| 2 — NEXORA chain config | COMPLETE, run #38071169448 `success` | `chain/nexora-devnet.json` (eip155:902024), `ci/phase2/*.sh`, deterministic genesis sha a04b29aa | CI link only; `chain/nexora-devnet.json` inspected locally (matches report) | **PASS by CI evidence; locally BLOCKED** | Collision check says 902024 absent from public lists (re-check before any public testnet); bech32 `cosmos` prefix change deferred (code-level); fee correction history recorded 2026-10-13. |
| 3 — Multi-validator + recovery | COMPLETE, run #38179431126 `success` | `ci/phase3/run-4validators.sh` T1–T6, `ci/testnet/*`, `testnet/ledger.json`+`state.json` (epoch 580) | CI link only; epoch workflow `.github/workflows/testnet-epoch.yml` exists; local has no evmd to run | **PASS by CI evidence; locally BLOCKED** | Single-host (4 validators, 1 host, loopback, 0 host-failure tolerance); no real-host fault injection; upstream test mnemonics; no monitoring/snapshots/incident docs. |
| 4 — AID spec & implementation | COMPLETE, run #38245177000 `success` | `aid/SPEC.md`, `aid/src/aid.mjs` + `aid/src/Aid.sol`, `aid/vectors.json`, `.github/workflows/aid-tests.yml` | Local JS suite **FAILED to run**: `ERR_MODULE_NOT_FOUND Cannot find package 'js-sha3'`; `aid/package.json` present but **no `package-lock.json`/`npm-shrinkwrap.json`/`node_modules` checked in**. No `npm ci` — local blocker only. Solidity side needs internet + Foundry absent locally | **BLOCKED locally; PASS by CI evidence** | Need `npm install js-sha3@0.9.3` with a committed lockfile before local gates; keccak KATs prove hash but do not audit spec-safety. |
| 5 — Registry + CREATE2 | COMPLETE, run #38247229940 `success` | `aid/src/AidRegistry.sol`, `aid/src/AidFactory.sol`, `aid/scripts/vanity.mjs`, `contracts/src/*` (7 contracts, TESTNET) | Same local blocker as Phase 4 (no js-sha3, no forge). Later contracts/vanity CI evidence referenced in README/STATUS (`38479155214`, vanity verify 19 checks) | **BLOCKED locally; PASS by CI evidence** | Contracts untested on the live NEXORA chain (Phase 6) per phase5-report §7; no audit, no governance/pause/upgrade path; 3 contracts explicitly test-only. Vanity proves arithmetic, not value. |

Notes:

- **No Phase 1–5 local rerun was possible** except file inspection; that is an environment
  fact (no Go 1.25.9, no Foundry, no docker, WSL/SYSTEM limitations per parent STATUS),
  not a finding that those CI runs did not happen. Exact GitHub Actions run links above
  are the evidence for their original "COMPLETE" claims.
- **Blocked/decision-required (must not be fabricated):** token economics (never decided
  — `docs/economics.md` reads "NO DECISIONS HAVE BEEN MADE"; supply, allocation,
  vesting, issuance, fee destination all undecided), legal/licensing, security audit
  (nothing audited), production credentials, market-data rights, asset ownership,
  validator key productionization. All remain BLOCKED/decision-required.
- `docs/STATUS.md` (clone, at `f9a0a5d`) is the clone's single source of truth and
  disagrees with the parent's `docs/STATUS.md` at the governance layer.
  Do not treat either as canonical without noting which baseline is being used.

## What was actually built this session (implemented / tested / verified)

All work is in untracked `workbench/`; tracked `main` files unchanged
(`status` still `?? workbench/` only). No commit, no merge, no push.

1. **Market integration workbench** — `workbench/phase6-integration/` — 85/85
   (Node v24.22.1, exit 0). Detailed manifest: `workbench/phase6-integration/INTEGRATION-MANIFEST.md`.
   Baseline canonical `market/`: 41/41, exit 0. Isolated ICMA workbench: 59/59;
   isolated curve workbench: 51/51 (isolated results do NOT count as integration —
   the adapter test exists precisely so this integration is not mistaken for it).
2. **NEXORA Scan local scaffold** — `workbench/nexora-scan/` — 11/11 (exit 0).
   Loopback-only, read-only, 8-method allowlist, 64 KB / 2 MB / 60-per-min caps,
   disconnected state. Detailed README: `workbench/nexora-scan/README.md`.
3. **AID local repro** — NOT solved: no lockfile. `npm ci` was NOT run (no lockfile);
   `npm install` was NOT run (would improvise version resolution). The fix is a
   committed `package-lock.json` in a future, normal install — recorded as the local
   blocker; remote CI remains green for the pinned dependency.
4. **Chain toolchain / local RPC** — NOT started: no `evmd` checked in, no Go to build
   one, WSL environment is the blocked one the parent STATUS documents.
   Local ports 8545/8546/26657/26656/1317/9090 are all ECONNREFUSED; TCP 3100 also
   ECONNREFUSED. The scanner reports Disconnected accordingly.
   The existing gateway `scripts/nexora-rpc-gateway.mjs` forwards full JSON-RPC
   (including `POST /evm` write methods) and binds `0.0.0.0` — it is NOT a safe
   template for the scanner, which therefore uses its own narrower proxy.

## Next gate

Phase 6 cannot claim "ready" until: a deliberate, reviewed adapter/merge step lands
ICMA + curve into canonical `market/` (or a decision to keep market as spec-checks-only);
EVM/RPC/gas is evidenced against a real node (needs the toolchain + Linux env); Phase 5
contracts run on that chain; credit-spread/FX/crypto scope is decided; and the AID
local suite reruns after a lockfile exists. Until then: **Phases 1–5 evidence is
recorded as PASS-by-CI / BLOCKED-locally, Phase 6 is IN PROGRESS, and nothing is
production-ready.

## Addendum — 2026-11-06: additional code-only Phase 6 work

A separate package was subsequently created at `workbench/phase6-market-models/`.
It adds constant continuous-compounded z-spread solving, FX carry/cross/triangle
diagnostics, deterministic crypto scenarios, a market-simulation reconstruction, and
v1→v2 migration for model JSON only. It is **not** a recovered historical implementation:
the accessible local Git metadata exposed only the root clone commit, and the scanned
Sale/Vesting simulations are unrelated to the fixed-income market simulation.

Validation after the final edits:
- `node --test test/*.test.mjs` in `workbench/phase6-market-models`: **20/20 pass, exit 0**.
- `node bench/benchmark.mjs`: exit 0; report at `workbench/phase6-market-models/perf-report.json`.
  Windows 11 Pro, Intel Core i5-8500 @ 3.00GHz, 15.78 GiB RAM, Node v24.22.1;
  25 samples × 100 operations after 10 warm-ups. p50/p95 ms/op: curve
  0.000991/0.009953; z-spread 1.526136/1.767900; FX forward
  0.000221/0.000891; whole simulation 1.681566/1.891244. Synthetic local
  microbenchmarks only, not production load tests.
- This simulation composes the separate `phase6-integration` curve module; it does not
  modify canonical `market/`, nor claim EVM/RPC or live-chain compatibility.

## Addendum — portable EVM toolchain attempt

A user-local portable Go 1.25.9 toolchain was extracted under
`workbench/toolchain/go/go`; `go version` returned `go1.25.9 windows/amd64`.
This supersedes the earlier statement that no Go binary was available. WSL remains
unavailable under the LocalSystem shell (`WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`), and the
pinned upstream build/testnet attempt is in progress; until `evmd` is built and live
RPC identity verified, the local-chain and Phase 5-on-chain gates remain BLOCKED.
No system-wide Go installation, DNS, Cloudflare, or public tunnel change was made.**
