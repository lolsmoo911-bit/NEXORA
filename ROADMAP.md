# NEXORA Network — Roadmap

Version: 0.2.0 (Phase 1 closed)
Rule: a phase is complete only when its deliverables and acceptance criteria
are verified with recorded commands and outputs. No phase skips ahead.

---

## Phase 0 — Reconnaissance (CLOSED — COMPLETE)

Deliverables: environment report; upstream comparison; baseline decision (ADR);
`README.md`, `SPEC.md`, `THREAT_MODEL.md`, `ROADMAP.md`,
`docs/architecture-decision-record.md`, `chain/upstream.md`,
`docs/phase0-report.md`.

Acceptance: baseline chosen with evidence; limitations reported honestly;
no build claimed that was not performed.

## Phase 1 — Unmodified reference chain (COMPLETED — 2026-10-10)

**Status:** COMPLETE. Verified by GitHub Actions [#38016004413](https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38016004413) on commit `515d0705988fccc5ea2774c3b29bd0257ded78ee`. Full evidence in [docs/phase1-report.md](docs/phase1-report.md).

Goal (met): build and run upstream `cosmos/evm` **v0.7.3 `evmd`** — **unmodified**, verify JSON-RPC and a simple Solidity deploy.

Evidence: `eth_chainId=0x40000` (262144), `net_version=262144`, block production (e.g. `0x1→0x4`), and `NexoraGreeter` deployed+called returning `"Hello NEXORA"`. Node ran in ephemeral CI environment only (not mainnet or permanent public network).

Explicitly **out** of this Phase 1 scope: any NEXORA customization (naming, chain config, genesis), AID/token work, and any consensus change.

Acceptance (met): reproducible build from clean checkout on CI; node produces blocks; JSON-RPC answers correct; contract deploys and callable; all transcripts recorded in artifact `phase1-transcripts`.

## Phase 2 — NEXORA chain configuration (COMPLETED — 2026-10-10)

**Status:** COMPLETE. Verified by GitHub Actions [#38071169448](https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38071169448) on commit `b1740e2e14d763a60925aefa9806bf79198cb319`. Evidence in [docs/phase2-report.md](docs/phase2-report.md); chain-id decision and collision check in [docs/phase2-chain-ids.md](docs/phase2-chain-ids.md).

Delivered (config-only, reversible; no consensus or EVM engine changes, no dependency bumps):
- Cosmos chain id `nexora-devnet-1`, EVM chain id **902024** (`0xdc388`), verified on-chain; the reference value `262144` was **not** reused because it belongs to a registered public chain.
- Native denom **`anex`** with 18-decimal bank metadata (display `nex`, symbol `NEX`) applied across Cosmos and EVM, with an assertion that no stale upstream denom remains in genesis.
- Deterministic genesis: two independent runs produced byte-identical files (`sha256 a04b29aaadf89a980b53f8d5420ecdf1e700c04204282e85da104533a00f00ae`), `evmd validate-genesis` passes.
- Node starts, produces blocks, and settles both a Cosmos bank transfer and an EVM transfer; a Solidity contract deploys and `greet()` returns `Hello NEXORA`.

Known limitations (documented, not worked around): bech32 prefix remains `cosmos` (a code-level change, deferred); the devnet ran only in an ephemeral CI environment.

Original plan (retained for traceability):

Goal: a NEXORA-branded devnet configuration **without** changing consensus or the EVM engine.

### Required considerations (non-exhaustive)
1. **Chain ID selection (non-conflicting):**
   - Choose a **Cosmos Chain ID** (string, e.g. `nexora-devnet-1`) distinct from upstream test IDs; maintain separation from EVM Chain ID to avoid confusion.
   - Choose an **EVM Chain ID** (integer) not in common public lists and collision-checked against known testnets (do not reuse `262144` unless justified). Document both explicitly.
2. **Coin denomination & 18-decimals:**
   - Define `anex` as the native denom with **18 decimals** (EVM-compatible). Set in genesis and any config references.
3. **Fees:**
   - Configure base/min gas/fee parameters consistent with evmd defaults where appropriate; document rationale and make reversible.
4. **Deterministic genesis:**
   - Generate genesis from a fixed seed set and scripted steps; ensure running the generator twice produces identical bytes (compare SHA256 of generated genesis files).
5. **Reversibility & validation:**
   - Keep changes to config/genesis scripts only (no consensus code changes). Run `evmd validate-genesis` on generated file.
6. **Verification:**
   - Start node with new config; verify transfers work and a Solidity contract deploys/calls; record transcripts.

### Acceptance
Deterministic genesis; documented parameters (both Chain IDs, denom decimals, fees); transfers and Solidity deploy succeed; no consensus code changes; rollback path documented.

**Implementation plan note:** 
- Create a minimal, reversible genesis/config generation script.
- Generate two independent runs → compare checksums of genesis artifacts.
- Explicitly document how to revert to reference (remove NEXORA-specific files/scripts).
- Do not modify reference code; avoid touching `cosmos/evm` sources.
- Test environment only; no mainnet or production keys.

## Phase 3 — Multi-validator devnet + recovery (COMPLETED — 2026-10-12)

**Status: COMPLETE.** Verified by GitHub Actions [#38179431126](https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38179431126) (conclusion: success) on commit `dc2df78eed51820f24b56d419eec76d66ae06be6`. Full evidence in [docs/phase3-report.md](docs/phase3-report.md).

Goal: ≥4 independent local validators — met (4 validators, 4 distinct addresses, 4 distinct monikers).

Acceptance, all met:
- 4 nodes reach consensus — `4/4 nodes agree at height 3`, identical `app_hash` at height 12.
- Killing one does not halt the chain — `height with 3 validators: 16 -> 29`.
- Restart re-syncs — `node3 caught up: height 35 (network 35) after 6s`.
- Recovery procedure documented and tested — `ci/phase3/run-4validators.sh` (T5, T6).
- Deterministic genesis — two independent runs produced byte-identical files.

Used the manual multi-home path rather than upstream `docker-compose.yml`, because the compose file starts the upstream chain, not the NEXORA-configured genesis.

Goal: ≥4 independent local validators.

Tasks: prefer upstream `docker-compose.yml` (`evmdnode0..3`) via
`make localnet-start`; provide a manual multi-home fallback without Docker;
test node stop/restart, state recovery, and one-validator fault.

Acceptance: 4 nodes reach consensus; killing one does not halt the chain;
restart re-syncs; recovery procedure documented and tested.

## Phase 4 — AID specification & implementation

Gate: only after Phase 1 accepted and human approves.

Deliverables: `aid/SPEC.md`, canonical encoding, reference library, Solidity
libraries, test vectors, unit + fuzz tests, deterministic `assetId`.

## Phase 5 — AID registry & deterministic CREATE2 deployment (COMPLETED — 2026-10-12)

**Status: COMPLETE.** Verified by GitHub Actions [#38247229940](https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38247229940) (conclusion: success). Full evidence in [docs/phase5-report.md](docs/phase5-report.md).

- Registry `aid/src/AidRegistry.sol` — metadata is re-hashed and checked against the identifier it is filed under; first claim wins; only the claimant retracts, and a retraction is final.
- CREATE2 factory `aid/src/AidFactory.sol` — collision guard, address re-derived from the actual deployment, salt commits to the init code.
- Vanity search `aid/scripts/vanity.mjs` — exact 16^k cost model, measured rate, projection for sizes not searched, and agreement with Foundry `cast compute-address`.
- Totals: 40/40 JavaScript tests, 45/45 Solidity tests.

Deliverables: minimal registry contract; CREATE2 factory; local vanity search
tool with honest complexity estimates and independent verification.

## Phase 6 — Compatibility, performance, security

Tasks: EVM/RPC compatibility matrix; gas accounting; fuzz; state-migration;
benchmark script + real results on named hardware; resolve critical/high
findings. Parallel execution only with documented design + benchmark.

## Phase 7 — Public testnet (conditional)

Gate: suitable infrastructure and independent operators available (requires
funding/external resources). Not startable at $0 without partners.

## Phase 8 — Production readiness

Deliverables: security review plan (scoped beyond the upstream Sherlock
audit), governance, incident response, key management, validator admission,
operational budget, legal review.

## Explicitly out of scope until Phases 1–3 pass

- AID implementation, token customization, registry, vanity addresses.
- Bridges, custom precompiles, novel consensus, parallel-execution engine.
- Any production keys, external deployment, or mainnet.

## Open Risks (noted)
- **Release family gap (2026.1):** Cosmos SDK/CometBFT family compatibility noted in `chain/upstream.md` and ADRs; track before moving beyond controlled dev environments.
- **Dependency support (long-term):** upstream `cosmos/evm` v0.7.3 pins specific SDK/CometBFT versions; monitor upstream support windows while remaining unmodified for verification phases.