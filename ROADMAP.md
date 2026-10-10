# NEXORA Network — Roadmap

Version: 0.1.0 (Phase 0)
Rule: a phase is complete only when its deliverables and acceptance criteria
are verified with recorded commands and outputs. No phase skips ahead.

---

## Phase 0 — Reconnaissance (CURRENT — COMPLETE, awaiting approval)

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

## Phase 2 — NEXORA chain configuration (minimal, reversible)

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

## Phase 3 — Multi-validator devnet + recovery

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

## Phase 5 — AID registry & deterministic CREATE2 deployment

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