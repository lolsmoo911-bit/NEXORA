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

## Phase 1 — Unmodified reference chain (owner-confirmed restricted scope, 2026-10-10)

Pre-condition: a suitable Linux environment verified against the
`docs/phase1-environment.md` checklist (real shell + toolchain; never the
no-shell sandbox — owner decision #5), raw transcripts recorded, and explicit
owner approval.

Goal: build and run upstream `cosmos/evm` **v0.7.3 `evmd`** — the **candidate**
(not final) reference — **unmodified**, then verify JSON-RPC and a simple
Solidity deploy. Mandatory scope (owner decision #6):

1. Clone `https://github.com/cosmos/evm.git`, checkout the pinned commit
   `c3ae9067a7eadcdea55a5192226916deb44c71c4`.
2. Build the **unmodified original**: `make build` in the repo and in `./evmd`.
3. Run the local node (`./local_node.sh -y`); confirm block production.
4. Test JSON-RPC: `eth_chainId`, `eth_blockNumber`, `net_version`.
5. Deploy and call a simple Solidity contract via JSON-RPC.

Explicitly **out** of this Phase 1 scope: any NEXORA customization (naming,
chain config, genesis), AID/token work, and any consensus change. Upstream
suites (`make test`, `make test-rpc-compat`, `make test-solidity`) and the
4-node localnet are **optional later verification steps**, only if separately
approved.

Acceptance: reproducible build from a clean clone; node produces blocks;
JSON-RPC answers; the Solidity contract deploys and is callable; recorded
transcript. Evidence logged in `docs/phase1-report.md`.

## Phase 2 — NEXORA chain configuration (minimal, reversible)

Goal: a NEXORA-branded devnet configuration **without** changing consensus or
the EVM engine.

Tasks: choose and collision-check chain-id; set 18-decimal `anex` denom and
base fee; rename binary/targets; deterministic genesis script; `validate-genesis`.

Acceptance: deterministic genesis; documented parameters; transfers and a
Solidity deploy succeed; no consensus code changed.

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