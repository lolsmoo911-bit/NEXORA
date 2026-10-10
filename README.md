# NEXORA Network

> **STATUS: PROVISIONAL — Phase 0 (environment & upstream reconnaissance) complete.**
> Nothing has been built or run yet; the reference chain has not been verified
> on real hardware. Names, token symbol, chain parameters, and architecture
> details remain under review.

NEXORA is an intended independent, EVM-compatible Layer 1 blockchain for
asset-oriented smart contracts, built entirely on open-source, permissively
licensed components with a **$0 operating budget** during development.

## Baseline (decided with evidence — see `docs/architecture-decision-record.md`)

| Layer | Choice | License | Pin |
|---|---|---|---|
| EVM framework | **Cosmos EVM** (`github.com/cosmos/evm`) | Apache-2.0 | v0.7.3 @ `c3ae9067a7eadcdea55a5192226916deb44c71c4` |
| Example chain | `evmd` (binary in `./evmd`) | Apache-2.0 | same release |
| Consensus | CometBFT | Apache-2.0 | v0.39.3 (inherited) |
| Chain stack | Cosmos SDK | Apache-2.0 | v0.54.3 (inherited) |
| EVM engine | Cosmos fork of go-ethereum | LGPL-3.0 | v1.17.2-cosmos-0 (inherited via `replace`) |
| Go toolchain | — | BSD-3-Clause | 1.25.9 (upstream build requirement) |

Independent audit on record from upstream: `docs/audits/sherlock_2025_07_28_final.pdf`
(Sherlock, **2025-07-28**). **Scope note:** it covers the **July-2025 codebase
state (≈v0.3.x era)** — ~14 months before v0.7.3 — not v0.7.3, and not NEXORA
customizations. Governs security planning; does not replace project-level review.

## Governing documents

- `SPEC.md` — master project specification (adapted and corrected).
- `THREAT_MODEL.md` — threat model and mitigations.
- `ROADMAP.md` — phases with deliverables and exit criteria.
- `docs/architecture-decision-record.md` — ADR-0001: baseline selection with evidence.
- `chain/upstream.md` — verified upstream inventory and pinned revisions.
- `docs/phase0-report.md` — Phase 0 deliverable report (this phase's record).
- `docs/phase1-environment.md` — Linux environment requirements + verification checklist.
- `docs/prisma-compute-feasibility.md` — feasibility study of Prisma Compute (free-tier plan; prepared, not deployed experiment; blocked chain hosting).

## Verified constraints (from upstream README)

- Cosmos EVM supports **18-decimal gas-token chains only**. NEX monetary
  parameters must respect this. The former bridge module `x/precisebank`
  (6→18 decimals) was **removed** upstream (PR #1019, 2026-03-02) and is not
  in the pinned tree; a non-18-decimal denom is not a supported option.
- The upstream repo is pre-v1.0: releases are `v0.x` until audit completion
  and benchmarking; this is acceptable for a local reference baseline.
- All dev accounts/mnemonics in upstream scripts are **test-only**; never reuse
  for any real funds.