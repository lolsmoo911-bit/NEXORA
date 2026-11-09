# NEXORA — Project Plan

**Version:** 1.0
**Date:** 2026-11-01
**Baseline:** [`FOUNDATION-ARCHITECTURE-v1.md`](FOUNDATION-ARCHITECTURE-v1.md)
**Status:** Planning document. No phase is complete.

---

## 1. Purpose and scope

This plan converts the approved architecture baseline into sequenced, evidence-gated phases. It defines what must be delivered, what must be true before advancing, and what is explicitly out of scope.

Scope boundary: multi-asset market information, portfolio visibility, simulated trading, a Cosmos-based test network with an oracle, a narrowly scoped digital-asset pilot, and regulated integrations only after legal and security gates.

Out of scope until separately approved: Mainnet, real-money trading, exchange order routing, custody of real assets, token issuance/sale, public network exposure.

## 2. Planning assumptions

1. The canonical workspace is `C:\Users\Administrator\NEXORA-ANEX-REBUILT`.
2. The architecture baseline is approved as direction, not as implemented fact.
3. No source code exists yet in the canonical workspace.
4. The current Windows/System process cannot run WSL or the Linux build toolchain.
5. Decisions D-001 through D-008 remain open and may change phase content.
6. All progress claims require stored evidence.

## 3. Phase overview

| Phase | Name | Entry condition | Exit gate |
|---|---|---|---|
| 0 | Foundation | Workspace established | Gate 0 |
| 1 | Market Data MVP | Gate 0 + D-001/D-002/D-004/D-008 decided | Gate 1 |
| 2 | Portfolios & Paper Trading | Gate 1 | Gate 2 |
| 3 | Cosmos Chain + Oracle Testnet | Gate 2 + toolchain available + D-006/D-007 decided | Gate 3 |
| 4 | Digital Asset Pilot | Gate 3 + D-003/D-005 resolved for pilot scope | Gate 4 |
| 5 | Regulated Integrations | Gate 4 + partner/licence readiness | Gate 5 / production approval |

Phases may overlap only where dependencies are explicitly satisfied. No phase may claim completion while its gate evidence is missing.

## 4. Phase 0 — Foundation

### Objective
Establish governance, architecture boundaries, data contracts, and risk artifacts so later work is not built on assumptions.

### Deliverables
- [x] Architecture baseline (`FOUNDATION-ARCHITECTURE-v1.md`).
- [x] Canonical workspace and legacy-source migration record.
- [x] Project plan, decision log, status, work queue.
- [x] Data-provider evaluation framework.
- [x] Security threat model.
- [ ] Canonical instrument taxonomy (asset classes, identifier rules, lifecycle).
- [ ] Canonical market-observation schema and normalization rules.
- [ ] Provider/licensing matrix populated with at least one evaluated candidate.
- [ ] Separate ANEX tokenomics workstream charter.
- [x] Subsystem ownership map (role-level v0.1; named individuals TBD; see [`SUBSYSTEM-OWNERSHIP.md`](SUBSYSTEM-OWNERSHIP.md)).

The subsystem map is role-level. Named individual owner assignments remain open, so Gate 0 is not passed.

### Gate 0 acceptance
- Every subsystem has a named owner, interface, and explicit non-responsibilities.
- The observation schema covers required provenance fields.
- Open assumptions and decisions are recorded in the decision log.
- No claim of implementation exists without evidence.

## 5. Phase 1 — Market Data MVP

### Objective
Deliver trustworthy, provenance-rich market data for exactly **one asset class** from **one permitted provider**, chosen by decision.

### Preconditions
- D-001 (provider), D-002 (asset class), D-004 (latency/delay), D-008 (licensing) decided.
- Written confirmation that display, storage, and intended use are permitted.

### Deliverables
- Ingestion adapter for the selected provider (streaming, polling, or batch as appropriate).
- Normalization into the canonical observation schema.
- Quality engine: timestamp validation, staleness, duplicates, outliers, crossed/conflicting values.
- Historical store with licensing-compliant retention.
- Read-only API and a minimal market dashboard.
- Provider health and feed-gap monitoring.
- Documented data-status labels (`REAL_TIME`, `DELAYED`, `END_OF_DAY`, `PERIODIC_NAV`, `REFERENCE_ONLY`, `INDICATIVE`, `STALE`, `UNAVAILABLE`).

### Gate 1 acceptance
- Every displayed value shows source and observation timestamp.
- Stale or conflicting data is detected and labeled, never silently replaced.
- A provider outage produces an explicit unavailable/stale state, not a fabricated value.
- Licensing permits the exact display and storage implemented.
- Reproducible tests cover normalization and quality rules.

## 6. Phase 2 — Portfolios & Paper Trading

### Objective
Provide simulated portfolios and paper order workflows that cannot be mistaken for real positions or real execution.

### Deliverables
- Simulated portfolio model (quantity, instrument, cost basis, valuation time, currency, source).
- Paper order lifecycle: validation, simulated buying power, simulated fills, cancellation.
- Valuation and performance calculations with documented method and time zone.
- Immutable audit trail for simulated state transitions.
- Clear UI/API labeling of simulated versus real.

### Gate 2 acceptance
- Simulated and real positions are structurally and visually distinguishable.
- Calculations are reproducible with deterministic test cases.
- No real order routing, custody, or funds movement is enabled.
- Risk checks and audit logs exist for paper orders.

## 7. Phase 3 — Cosmos Chain + Oracle Testnet

### Objective
Produce an actual, reproducible Cosmos SDK application chain and oracle testnet, with no Mainnet and no real assets.

### Preconditions
- Supported Linux/WSL environment with verified `go`, `git`, build tools, and Ignite (or an approved alternative).
- D-006 (oracle policy) and D-007 (IBC necessity) decided.
- Phase 2 gate passed.

### Deliverables
- Cosmos SDK source scaffold with pinned dependencies.
- Local development network and multi-validator test environment.
- Oracle message format: source identity, observation/publication time, quality, instrument, methodology version.
- Freshness thresholds, replay protection, signer rotation, authorization rules.
- On-chain modules only for validated requirements; no raw tick storage.
- Build and test automation with captured output.

### Gate 3 acceptance
- Reproducible build from a clean environment.
- Unit and integration tests pass with stored reports.
- Chain initialization and local testnet smoke tests pass.
- Oracle rejects stale, malformed, replayed, and unauthorized observations.
- No Mainnet configuration or real assets.

## 8. Phase 4 — Digital Asset Pilot

### Objective
Represent one narrowly scoped asset or contractual right with documented legal, custody, and lifecycle controls.

### Preconditions
- Gate 3 passed.
- D-003 (jurisdiction) and pilot-relevant D-005 (ANEX/token model) resolved.
- Legal review scoped and funded.

### Deliverables
- Documented issuer, rights, transfer restrictions, custody/registration, and redemption/claim process.
- Token registry and transfer rules for the pilot asset only.
- Supply reconciliation between on-chain records and legal/operational records.
- Pause, recovery, and incident procedures.
- Independent smart-contract and operational review.

### Gate 4 acceptance
- Legal review and required permissions documented.
- Issuance, transfer, pause, and redemption/claim processes tested.
- Supply reconciliation demonstrated.
- Independent review complete with findings resolved or accepted.
- No public sale or unlicensed distribution.

## 9. Phase 5 — Regulated Integrations

### Objective
Connect to qualified trading, custody, and financial partners where required, under confirmed licences and production controls.

### Deliverables
- Partner integrations behind provider-neutral interfaces.
- Production monitoring, reconciliation, incident response, and compliance controls.
- Jurisdictional approvals and contractual responsibility boundaries.
- Security audit and operational readiness review.

### Gate 5 acceptance
- Required licences/partners and jurisdictional approvals confirmed.
- Security audit complete; critical/high findings resolved.
- Incident drills and recovery procedures exercised.
- Production enablement approved as a separate, explicit decision.

## 10. Cross-cutting workstreams

| Workstream | Responsibility | Current state |
|---|---|---|
| Architecture & interfaces | Subsystem boundaries, contracts | Baseline documented; role-level ownership map v0.1 created; named owners pending |
| Data & licensing | Provider rights, retention, redistribution | Framework documented; no provider selected |
| Security | Threat model, key management, review | Threat model documented; controls not implemented |
| Tokenomics | ANEX supply, utility, governance | Unresolved; charter pending |
| Legal & compliance | Jurisdiction, custody, issuance | Not started |
| Platform engineering | Environments, CI, builds | Blocked by toolchain |

## 11. Definition of done (applies to every deliverable)

1. Implemented in the canonical workspace and reviewable.
2. Tested with captured output.
3. Verified with stored evidence (hash, log, report).
4. Documented, including limits and non-goals.
5. Safe: no secrets, no real-money/Mainnet/custody enablement.
6. Traceable to a work-queue item and, where relevant, a decision.

## 12. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Unlicensed data use | Legal/contractual exposure | Decide D-008 before ingestion; store entitlement metadata |
| Fabricated or stale prices | Financial harm, trust loss | Quality engine, explicit unavailable states, no silent fill |
| Toolchain unavailable | Schedule slip | Treat builds as blocked; do not fake evidence |
| Tokenomics ambiguity | Economic/legal risk | Keep ANEX provisional; separate charter; no issuance |
| Scope creep into real money | Regulatory/security exposure | Hard phase gates; simulation-only until Gate 5 |
| Secret leakage | Compromise | No secrets in repo/logs; least privilege; scanning |
| Oracle manipulation/replay | On-chain integrity loss | Quorum/freshness/replay rules; independent review |

## 13. Change control

- Material scope or architecture changes require an entry in [`DECISION-LOG.md`](DECISION-LOG.md).
- Status changes require evidence referenced in [`STATUS.md`](STATUS.md).
- Work is tracked in [`WORK-QUEUE.md`](WORK-QUEUE.md); no undocumented parallel workstreams.
