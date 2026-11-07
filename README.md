# NEXORA — Canonical Project Workspace

**Canonical path:** `C:\Users\Administrator\NEXORA-ANEX-REBUILT`
**Document status:** Governance baseline, created 2026-11-01
**Product status:** Foundation documentation plus a local-only provisional market-data slice. No chain source, chain build, or chain test is verified.

---

## 1. What this repository is

NEXORA is a planned multi-asset financial-data and digital-asset platform. It is **not** defined as "a blockchain plus a token." Market feeds, trading, custody/legal ownership, and blockchain settlement are separate subsystems with explicit boundaries.

The approved product baseline is [`docs/FOUNDATION-ARCHITECTURE-v1.md`](docs/FOUNDATION-ARCHITECTURE-v1.md). All other documents in this workspace derive from it and must not contradict it without a recorded decision.

Core baseline principles:

1. Correctness before speed; never present stale or unverified data as authoritative.
2. Every market datum carries provenance: source, timestamps, market context, currency, quality state.
3. High-volume raw market data stays **off-chain**.
4. Simulation and paper trading come before any real-money workflow.
5. A token does not by itself create legal ownership, redemption rights, or a claim on an asset.
6. ANEX is **provisionally** the native network token; supply and tokenomics are unresolved.
7. A feature is not "built," "live," "secure," or "audited" until evidence supports that claim.

## 2. Canonical location and legacy source handling

This path is the single canonical workspace going forward:

```
C:\Users\Administrator\NEXORA-ANEX-REBUILT
```

The previous source location was:

```
E:\NEXORA-ANEX-REBUILT
```

Handling performed on 2026-11-01:

- The old workspace contained **10 legacy probe log files** under `logs/` from two runs: `inspect-20261031233746.*` and `recheck-1031-20261031233330.*`.
- All 10 were copied to [`logs/legacy/`](logs/legacy/), preserving filenames.
- SHA-256 was computed on each source file, recomputed on each destination file, and all 10 matched with identical byte lengths.
- Only after full verification were the 10 source files removed from `E:\NEXORA-ANEX-REBUILT\logs\`. The old `logs\` directory remains, empty.
- The migration evidence log is at [`logs/legacy-migration-20261101-000352.txt`](logs/legacy-migration-20261101-000352.txt).
- No `docs/` directory was present on `E:\NEXORA-ANEX-REBUILT`; the architecture baseline existed only in the canonical workspace.
- No source code, build artifacts, or databases were found on the old path, so none were moved.

Rule going forward: **no source artifact is deleted until destination hashes are verified.** If a hash check ever fails, both sides are preserved and the discrepancy is reported.

## 3. Current state (accurate as of 2026-11-01)

| Area | State |
|---|---|
| Foundation architecture | Documented and approved as direction |
| Governance documents | Created (this set) |
| Market data (MVP slice) | Working locally: Frankfurter blended daily FX reference; provisional, not production |
| Portfolio / paper trading | Not implemented |
| Cosmos SDK chain source | Not generated or verified |
| Oracle module | Not implemented |
| Digital asset pilot | Not started |
| Build / test evidence | Python 3.13.7; 43 unit tests pass, including the quality/health/gap slice; earlier live fetch + local smoke test pass. Chain build/tests remain unavailable |
| Mainnet / real money / custody | Not authorized and out of scope |

See [`docs/STATUS.md`](docs/STATUS.md) for the detailed evidence-based status.

### Implemented locally on 2026-11-01

A first working, local-only market-data slice exists at [`apps/market-data-hub/`](apps/market-data-hub/README.md):

- Frankfurter v2 blended **daily FX reference rates** for USD/EUR, USD/GBP, USD/JPY, USD/CHF.
- Python 3.13 standard library only; SQLite; binds `127.0.0.1`; read-only `/health`, `/api/v1/fx/rates`, `/api/v1/quality/summary`, `/api/v1/providers/health`, and `/api/v1/quality/gaps`.
- Quality statuses `FRESH`, `STALE`, `FUTURE_DATE`, `UNKNOWN` computed on read from observation date; provisional 4-calendar-day threshold; future-dated rows rejected at ingestion when `as_of` is supplied. D-004 remains open.
- Provider contribution objects (`key`, `date`, `rate`, `excluded`) and included/excluded keys are preserved; missing/empty provider arrays are labeled `NOT_PROVIDED_OR_PEGGED` as a documented ambiguity.
- Provider health records explicit one-shot CLI attempts only; gap visibility is capped `POTENTIAL_WEEKDAY_GAP` output with no holiday calendar or interpolation.
- 43 unit tests pass (final quality-slice exit 0): `logs/quality-final-tests-20261101-003212.txt`; `compileall` exit 0: `logs/quality-final-compile-20261101-003221.txt`; one live fetch stored 4 rows; earlier local API/UI smoke test passes.
- Earlier validation: `logs/quality-tests-20261101-002830.txt` (43/43, exit 0), `logs/validation-tests-20261101-001651.txt` (21/21, exit 0), `logs/validation-compile-20261101-001703.txt` (`compileall`, exit 0).
- Historical slice evidence: `logs/mvp-tests-20261101-001348.txt`, `logs/mvp-fetch-20261101-001358.txt`, `logs/mvp-smoke-20261101-001429.txt`.

This is **not** production-ready, not real-time, and not a final provider/asset decision. The quality/health/gap baseline is narrow and provisional. Chain source, builds, and tests remain blocked.

## 4. Delivery phases

Detailed deliverables and exit criteria are in [`docs/PROJECT-PLAN.md`](docs/PROJECT-PLAN.md).

| Phase | Name | Goal | Status |
|---|---|---|---|
| 0 | Foundation | Architecture, data model, provider/licensing matrix, threat model, tokenomics workstream | In progress (docs) |
| 1 | Market Data MVP | One permitted provider and one asset class after decision; ingestion, normalization, quality checks, read-only API | In progress — provisional local slice plus narrow quality/health/gap baseline; final provider/asset decisions and D-004/D-008 remain open |
| 2 | Portfolios & Paper Trading | Simulated portfolios, paper orders/fills, valuation, audit trail | Planned |
| 3 | Cosmos Chain + Oracle Testnet | Cosmos SDK chain, local multi-validator testnet, oracle message and freshness rules | Planned — blocked on toolchain |
| 4 | Digital Asset Pilot | One narrowly scoped asset representation with documented legal/custody structure | Planned |
| 5 | Regulated Integrations | Licensed partners, production operations, audits, jurisdictional approvals | Planned |

Phase 1 explicitly starts with **one permitted data provider and one asset class, chosen by decision**, not by assumption.

## 5. Definition of done (project-wide)

A work item is "done" only when all of the following are true:

1. **Implemented** — the change exists in the canonical workspace and is reviewable.
2. **Tested** — automated or documented manual tests have run, with captured output.
3. **Verified** — evidence (logs, hashes, test reports) is stored and referenced.
4. **Documented** — behavior, limits, and non-goals are written down.
5. **Safe** — no secrets, no real-money enablement, no Mainnet, no unauthorized custody.
6. **Traceable** — linked to a decision (if it resolves one) and to a queue item.

A document alone is not "implemented software." Planned work must stay labeled **Planned** until evidence exists.

## 6. Acceptance gates (summary)

- **Gate 0 → 1:** architecture baseline, data model, provider/licensing matrix, threat model, and named owners exist; open decisions are recorded, not hidden.
- **Gate 1 → 2:** every quote shows source and timestamp; stale/conflicting data is labeled; provider outage cannot fabricate values; licensing permits intended use.
- **Gate 2 → 3:** simulated and real positions are impossible to confuse; calculations are reproducible; no real orders or custody are enabled.
- **Gate 3 → 4:** reproducible build and passing tests; local testnet smoke tests pass; oracle rejects stale, malformed, replayed, and unauthorized data; no Mainnet.
- **Gate 4 → 5:** legal review, documented issuer/rights/custody, tested issuance/transfer/pause/redemption, independent contract and operational review.
- **Gate 5 → production:** licenses/partners confirmed, security audit and incident drills complete, production enablement separately approved.

## 7. Decision register

Unresolved decisions are tracked in [`docs/DECISION-LOG.md`](docs/DECISION-LOG.md). The mandatory open items are:

| ID | Decision |
|---|---|
| D-001 | First permitted market-data source/provider |
| D-002 | First launch asset class |
| D-003 | First launch jurisdiction and user segment |
| D-004 | Target latency and acceptable delay per asset class |
| D-005 | ANEX supply, precision, issuance, and tokenomics |
| D-006 | Oracle source policy, signer governance, and failure thresholds |
| D-007 | Whether IBC is required in the first testnet |
| D-008 | Data licensing, storage, display, and redistribution rights |

## 8. Operating constraints

This project is managed under strict constraints:

- Hidden/background operation only; no GUI or visible windows.
- No elevation changes, self-elevation, service/registry/policy changes, or bypassing user security.
- No Mainnet, real-money trading, exchange orders, transactions, custody, or token issuance.
- No Git push/publication or secret exposure.
- Cloudflare One remote access is limited to task-required, named subdomains under `sageswap.dpdns.org`, using existing authenticated tooling and resources. Publish only after read-only inspection and verified Access protection for the exact hostname and service. No speculative hostnames, public quick tunnels, Everyone/allow-all policies, or exposure of admin, write, shell, database, credential, trading, or other sensitive endpoints. Prefer GET/HEAD-only and remove task-created resources when no longer needed.
- Source artifacts are preserved until hash-verified at the destination.
- No sleeps, polling loops, or repeated shell probes; work uses one-shot commands that write completion reports.

## 9. Environment blocker

The current process runs as `NT AUTHORITY\SYSTEM` and WSL returns `WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`. The required Linux toolchain (`go`, `git`, `docker`, `ignite`, `qemu-system-x86_64`) is not available. Until a properly supported Linux/WSL session exists, **source generation and builds remain unverified and must not be claimed**.

## 10. Document index

| Document | Purpose |
|---|---|
| [`docs/FOUNDATION-ARCHITECTURE-v1.md`](docs/FOUNDATION-ARCHITECTURE-v1.md) | Approved product and architecture baseline |
| [`docs/SUBSYSTEM-OWNERSHIP.md`](docs/SUBSYSTEM-OWNERSHIP.md) | Role-level subsystem ownership, interfaces, and non-responsibilities |
| [`docs/PROJECT-PLAN.md`](docs/PROJECT-PLAN.md) | Phases, deliverables, gates, sequencing |
| [`docs/DECISION-LOG.md`](docs/DECISION-LOG.md) | Decision register and rationale |
| [`docs/STATUS.md`](docs/STATUS.md) | Evidence-based current state |
| [`docs/WORK-QUEUE.md`](docs/WORK-QUEUE.md) | Prioritized work items |
| [`docs/DATA-PROVIDERS.md`](docs/DATA-PROVIDERS.md) | Provider evaluation and licensing rules |
| [`docs/RESEARCH-MARKET-DATA-MVP.md`](docs/RESEARCH-MARKET-DATA-MVP.md) | Provider research and provisional MVP decision |
| [`docs/LEGACY-MIGRATION-REPORT.md`](docs/LEGACY-MIGRATION-REPORT.md) | Verified 10-file legacy log migration |
| [`apps/market-data-hub/README.md`](apps/market-data-hub/README.md) | Implemented local market-data slice |
| [`docs/SECURITY-THREAT-MODEL.md`](docs/SECURITY-THREAT-MODEL.md) | Trust boundaries and threats |
| [`scripts/README.md`](scripts/README.md) | Script conventions and status |
| [`logs/README.md`](logs/README.md) | Log locations, retention, legacy record |
