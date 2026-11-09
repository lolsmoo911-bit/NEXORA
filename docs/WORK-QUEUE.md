# NEXORA — Work Queue

**Version:** 1.0
**Date:** 2026-11-01
**Baseline:** [`FOUNDATION-ARCHITECTURE-v1.md`](FOUNDATION-ARCHITECTURE-v1.md)

Prioritized, evidence-gated work. Status values: `DONE` · `IN PROGRESS` · `PLANNED` · `BLOCKED` · `DEFERRED`.

Rules:
- Only `DONE` items have verified evidence.
- `BLOCKED` items state the exact blocker.
- No item is marked done because a document was written, unless the deliverable *is* the document.

---

## 1. Immediate next three

| # | Item | Why now |
|---|---|---|
| 1 | Review and accept the provisional MVP + quality-slice evidence; decide whether FX daily reference remains Phase 1 scope and whether the 4-day threshold is acceptable | Confirms D-001/D-002/D-004/D-008 direction before expanding |
| 2 | Populate the provider/licensing matrix for Frankfurter and define retention/redistribution limits | Converts research into an approved data-rights record |
| 3 | Secure a supported Linux/WSL session and verify the chain toolchain | Unblocks all Cosmos chain work; current SYSTEM/WSL state makes builds impossible |

**Current gate:** Immediate item 1 is `BLOCKED / awaiting owner` (`D-001`, `D-002`, `D-004`, `D-008`); no decision is inferred. Item 2 is limited to factual provider/licensing population until `D-001`/`D-008`. Item 3 is `BLOCKED` by the SYSTEM/WSL environment. Named individual subsystem owners remain `TBD`; see [`SUBSYSTEM-OWNERSHIP.md`](SUBSYSTEM-OWNERSHIP.md) §5.

---

## 2. Queue

### Foundation (Phase 0)

| ID | Task | Status | Depends on | Evidence / note |
|---|---|---|---|---|
| NX-001 | Establish canonical workspace | DONE | — | `C:\Users\Administrator\NEXORA-ANEX-REBUILT` |
| NX-002 | Migrate legacy logs with hash verification | DONE | NX-001 | 10/10 SHA-256 match; `docs/LEGACY-MIGRATION-REPORT.md` |
| NX-003 | Publish architecture baseline | DONE | — | `docs/FOUNDATION-ARCHITECTURE-v1.md` |
| NX-004 | Create governance document set | DONE | NX-003 | README + docs + scripts/logs READMEs |
| NX-005 | Canonical instrument taxonomy | PLANNED | D-002 | Asset classes, identifiers, venue/symbol rules, lifecycle |
| NX-006 | Canonical market-observation schema | PLANNED | NX-005 | Provenance fields per architecture §6 |
| NX-007 | Provider/licensing matrix (populated) | PLANNED | D-001, D-008 | At least one evaluated candidate with written terms |
| NX-008 | Subsystem ownership map | DONE | NX-003 | Role-level v0.1: [`SUBSYSTEM-OWNERSHIP.md`](SUBSYSTEM-OWNERSHIP.md); named individuals TBD; Gate 0 not passed |
| NX-009 | ANEX tokenomics charter | PLANNED | D-005 | Separate workstream; no issuance |
| NX-010 | Data-retention and entitlement rules | PLANNED | D-008 | Maps contract terms to storage/display behavior |

### Market Data MVP slice (provisional, implemented locally)

| ID | Task | Status | Depends on | Evidence / note |
|---|---|---|---|---|
| NX-011 | Research providers and licensing | DONE | — | `docs/RESEARCH-MARKET-DATA-MVP.md` |
| NX-012 | Frankfurter v2 adapter (one-shot fetch, Decimal JSON) | DONE | NX-011 | `src/nexora_market_data/provider_frankfurter.py`; provider tests |
| NX-013 | Strict normalizer + data labels | DONE | NX-012 | `normalizer.py`; rejects bad currency/rate/date/schema |
| NX-014 | SQLite store + dedupe upsert | DONE | NX-013 | `store.py`; dedupe tests |
| NX-015 | Read-only local API | DONE | NX-014 | `api.py`; `/health`, `/api/v1/fx/rates`; 127.0.0.1 only |
| NX-016 | Static UI with non-executable notice | DONE | NX-015 | `web/`; notice + attribution |
| NX-017 | Unit tests | DONE | NX-012–NX-016 | 43/43 pass, exit 0: `logs/quality-final-tests-20261101-003212.txt`; `compileall` exit 0: `logs/quality-final-compile-20261101-003221.txt`; earlier 21/21: `logs/mvp-tests-20261101-001348.txt` |
| NX-018 | Live fetch + local capture | DONE | NX-017 | HTTP 200, 4 rows: `logs/mvp-fetch-20261101-001358.txt`, `var/last-fetch.json`; not repeated for quality slice |
| NX-019 | API/UI smoke test with live store | DONE | NX-018 | exit 0: `logs/mvp-smoke-20261101-001429.txt` |
| NX-028 | Quality evaluation baseline | DONE | NX-013 | `quality.py`; `FRESH`/`STALE`/`FUTURE_DATE`/`UNKNOWN`; observation-date freshness; provisional 4-day threshold; D-004 open |
| NX-029 | Provider attempt history + health | DONE | NX-014 | `provider_fetch_attempts`; CLI success/failure recording; `GET /api/v1/providers/health`; no scheduler |
| NX-035 | Potential weekday gap visibility | DONE | NX-013 | `quality.py`; `POTENTIAL_WEEKDAY_GAP`; weekends skipped; no holiday calendar or interpolation |
| NX-036 | Quality/health/gap API + UI indicator | DONE | NX-028, NX-029, NX-035 | `/api/v1/quality/summary`, `/api/v1/quality/gaps`; compact UI quality column |

This slice is local-only and provisional. It does not satisfy the full Phase 1 gate: broad quality-engine breadth, mature provider health, retention policy, and the populated licensing matrix remain incomplete. D-001, D-002, D-004, and D-008 remain open.

### Market Data MVP (Phase 1)

| ID | Task | Status | Depends on | Evidence / note |
|---|---|---|---|---|
| NX-020 | Select final first provider and asset class | BLOCKED | D-001, D-002 | Provisional slice NX-011–NX-019 implemented; final decision open |
| NX-021 | Ingestion adapter | BLOCKED | NX-020, NX-006 | No code yet |
| NX-022 | Normalization pipeline | BLOCKED | NX-006, NX-021 | — |
| NX-023 | Data-quality engine | BLOCKED | NX-022 | Provisional NX-028 baseline only; staleness, duplicates, outliers, conflicts not complete |
| NX-024 | Historical store | BLOCKED | NX-020, D-008 | Licensing-compliant retention |
| NX-025 | Read-only API + minimal dashboard | BLOCKED | NX-022, NX-023 | Provisional NX-036 API/UI only; source/timestamp visible per value |
| NX-026 | Provider health and feed-gap monitoring | BLOCKED | NX-021 | Provisional NX-029/NX-035 baseline; no silent fabrication on outage |
| NX-027 | Phase 1 test suite and gate evidence | BLOCKED | NX-021–NX-026 | Gate 1 |

### Portfolios & Paper Trading (Phase 2)

| ID | Task | Status | Depends on | Evidence / note |
|---|---|---|---|---|
| NX-030 | Portfolio model and valuation spec | PLANNED | Gate 1, D-009 | — |
| NX-031 | Simulated portfolio service | BLOCKED | NX-030 | — |
| NX-032 | Paper order lifecycle | BLOCKED | NX-031 | Validation, fills, cancel |
| NX-033 | Audit trail | BLOCKED | NX-031, NX-032 | Immutable simulated transitions |
| NX-034 | Phase 2 deterministic tests and gate evidence | BLOCKED | NX-031–NX-033 | Gate 2 |

### Cosmos Chain + Oracle Testnet (Phase 3)

| ID | Task | Status | Depends on | Evidence / note |
|---|---|---|---|---|
| NX-040 | Verify supported Linux/WSL toolchain | BLOCKED | Environment | `WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`; SYSTEM identity |
| NX-041 | Generate Cosmos SDK scaffold with pinned deps | BLOCKED | NX-040 | No source generated |
| NX-042 | Local multi-validator testnet | BLOCKED | NX-041 | — |
| NX-043 | Oracle message format and signer model | BLOCKED | D-006 | — |
| NX-044 | Freshness, replay, authorization enforcement | BLOCKED | NX-043 | — |
| NX-045 | Reproducible build + test reports | BLOCKED | NX-040, NX-041 | Gate 3 |
| NX-046 | IBC decision and, if required, integration | BLOCKED | D-007 | — |

### Digital Asset Pilot (Phase 4)

| ID | Task | Status | Depends on | Evidence / note |
|---|---|---|---|---|
| NX-050 | Pilot asset scope and legal structure | DEFERRED | Gate 3, D-003, D-018 | — |
| NX-051 | Token registry and transfer rules | DEFERRED | NX-050 | — |
| NX-052 | Supply reconciliation | DEFERRED | NX-051 | On-chain vs legal records |
| NX-053 | Pause/recovery/incident procedures | DEFERRED | NX-051 | — |
| NX-054 | Independent contract/operational review | DEFERRED | NX-051–NX-053 | Gate 4 |

### Regulated Integrations (Phase 5)

| ID | Task | Status | Depends on | Evidence / note |
|---|---|---|---|---|
| NX-060 | Partner and licence model | DEFERRED | Gate 4, D-017 | — |
| NX-061 | Production monitoring/reconciliation | DEFERRED | NX-060 | — |
| NX-062 | Security audit and incident drills | DEFERRED | NX-060 | — |
| NX-063 | Production enablement decision | DEFERRED | NX-060–NX-062 | Separate approval |

---

## 3. Definition of done for a queue item

1. Implemented in the canonical workspace.
2. Tested with captured output.
3. Verified with stored evidence.
4. Documented, including limits.
5. Safe (no secrets, no real money/Mainnet/custody).
6. Linked to a decision where applicable.

## 4. WIP limits

- At most **one** Phase 1 engineering item in progress at a time until the first provider is live.
- No Phase 3 code work until NX-040 is `DONE`.
- No Phase 4 work until Gate 3 is passed.
