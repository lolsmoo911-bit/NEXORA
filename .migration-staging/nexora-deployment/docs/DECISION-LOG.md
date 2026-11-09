# NEXORA — Decision Log

**Version:** 1.0
**Date:** 2026-11-01
**Baseline:** [`FOUNDATION-ARCHITECTURE-v1.md`](FOUNDATION-ARCHITECTURE-v1.md)

This is the single register for material product, architecture, data, legal, and token decisions. A decision is not "made" because it is discussed; it is made only when recorded here with an owner, rationale, and evidence.

**Status values:** `DECIDED` · `OPEN` · `DEFERRED` · `SUPERSEDED`

---

## 1. Decided (baseline)

These are inherited from the approved architecture baseline or from the workspace setup. They are direction, not proof of implementation.

| ID | Decision | Status | Rationale / evidence |
|---|---|---|---|
| D-000 | Canonical workspace is `C:\Users\Administrator\NEXORA-ANEX-REBUILT`. | DECIDED | User instruction; migration report in `logs/legacy-migration-20261101-000352.txt`. |
| D-010 | NEXORA is a multi-asset financial-data and digital-asset platform, not "a blockchain plus a token." | DECIDED | Architecture §1–2. |
| D-011 | Market data, trading, custody/legal ownership, and blockchain settlement are separate subsystems. | DECIDED | Architecture §2, §4. |
| D-012 | Raw/high-frequency market data stays off-chain. | DECIDED | Architecture §2.4, §4.8–4.9. |
| D-013 | Simulation and paper trading precede any real-money workflow. | DECIDED | Architecture §2.5, §8. |
| D-014 | ANEX is provisionally the native network token; it is not a stablecoin, backed claim, or redemption right. | DECIDED (provisional) | Architecture §5. Supply/tokenomics remain open (D-005). |
| D-015 | No Mainnet, real-money trading, custody, exchange orders, or token issuance during foundation work. | DECIDED | Operating constraints; architecture §9, §11. |
| D-016 | No source artifact is deleted before destination hash verification. | DECIDED | Operating constraint; applied in legacy migration. |
| D-019 | First working slice uses Frankfurter v2 **blended** daily FX reference rates (base USD; quotes EUR, GBP, JPY, CHF), labeled `DAILY_REFERENCE` / `MID` / non-executable. | DECIDED (engineering, provisional) | [`RESEARCH-MARKET-DATA-MVP.md`](RESEARCH-MARKET-DATA-MVP.md); live fetch 2026-10-31T23:14:00Z stored 4 rows; 21 tests pass. Final D-001/D-002 remain open. |
| D-020 | MVP storage/display policy: store source, observation date, `received_at`, status, and contributing providers; show the non-executable notice; keep per-provider filters disabled until each source's terms are reviewed; no redistribution service. | DECIDED (MVP) | Architecture §3.1, §6; Frankfurter FAQ/licence; implementation in `apps/market-data-hub/`. |

---

## 2. Open decisions

Each open item must be resolved before the phase that depends on it. Until then, dependent work is labeled **Planned** or **Blocked**, never complete.

### D-001 — First permitted market-data source/provider
- **Status:** OPEN
- **Needed by:** Phase 1 (Gate 0 → 1)
- **Question:** Which single provider is permitted, affordable, and technically suitable for the first asset class?
- **Required evidence:** written licence/terms covering display, storage, derived use, and redistribution limits; API/feed documentation; rate limits; SLA; cost; sandbox access.
- **Options:** licensed exchange feed; licensed aggregator/reference-data vendor; public reference API with explicit reuse terms; partner-supplied feed.
- **Decision owner:** TBD (product + legal)
- **Notes:** MVP slice uses Frankfurter under D-019. Final provider selection for Phase 1 remains open. See [`DATA-PROVIDERS.md`](DATA-PROVIDERS.md).

### D-002 — First launch asset class
- **Status:** OPEN
- **Needed by:** Phase 1
- **Question:** Which one asset class launches first: FX, equities, fixed income, funds/NAV, digital assets, or indices?
- **Required evidence:** data availability and licensing, user value, normalization complexity, quality-rule maturity, regulatory sensitivity.
- **Decision owner:** TBD (product)
- **Notes:** Launch scope is exactly one class; others remain candidates. The first engineering slice uses FX daily reference rates (D-019); this does not finalize the launch class.

### D-003 — First launch jurisdiction and user segment
- **Status:** OPEN
- **Needed by:** Phase 4 (and informs Phase 1–2 design)
- **Question:** Which jurisdiction and which user segment (e.g., professional vs retail) are in scope first?
- **Required evidence:** legal review of data display, trading, custody, and token treatment; licensing obligations; tax/reporting implications.
- **Decision owner:** TBD (legal + business)

### D-004 — Target latency and acceptable delay by asset class
- **Status:** OPEN
- **Needed by:** Phase 1
- **Question:** What freshness is required, and what delay is acceptable, per asset class and use case?
- **Required evidence:** product requirements; provider capabilities; cost of real-time vs delayed; explicit staleness thresholds.
- **Decision owner:** TBD (product + engineering)
- **Notes:** A single global latency target is not assumed. The MVP slice accepts a daily reference cadence and labels it as such; final thresholds remain open.

### D-005 — ANEX supply, precision, issuance, and tokenomics
- **Status:** OPEN
- **Needed by:** Phase 3–4 (chain economics), and any issuance decision
- **Question:** What are total supply, denomination precision, mint/burn authority, issuance schedule, inflation, validator rewards, community allocation, fee destination, and governance/upgrade controls?
- **Required evidence:** tokenomics specification; reconciliation of historical ANEX figures at a common block height; legal review; no implied backing or return.
- **Decision owner:** TBD (tokenomics + legal)
- **Notes:** ANEX remains provisional. No issuance or sale is authorized.

### D-006 — Oracle source policy, signer governance, and failure thresholds
- **Status:** OPEN
- **Needed by:** Phase 3
- **Question:** Which sources feed the oracle, who may sign, how are signers rotated, what quorum/freshness/deviation rules apply, and when is an asset halted or marked unavailable?
- **Required evidence:** oracle specification; threat review; replay and rotation tests; failure-mode analysis.
- **Decision owner:** TBD (engineering + security)

### D-007 — Whether IBC is required in the first testnet
- **Status:** OPEN
- **Needed by:** Phase 3
- **Question:** Is IBC needed for the first testnet, or can it be deferred until interoperability requirements are understood?
- **Required evidence:** concrete interoperability use case; security review; operational cost; dependency impact.
- **Decision owner:** TBD (architecture)
- **Notes:** Baseline says IBC only after requirements are understood.

### D-008 — Data licensing, storage, display, and redistribution rights
- **Status:** OPEN
- **Needed by:** Phase 1
- **Question:** What may NEXORA store, display, derive, cache, and redistribute, and for how long, per provider and asset class?
- **Required evidence:** contract terms mapped to system behavior; retention rules; entitlement metadata in the data model; audit trail.
- **Decision owner:** TBD (legal + data)
- **Notes:** Licensing constrains architecture; it is not an afterthought. Frankfurter's FAQ permits storing/caching blended daily rates and free commercial use of the blend; third-party redistribution and per-provider terms remain open.

### D-009 — Portfolio model and external account connections
- **Status:** DEFERRED
- **Needed by:** Phase 2
- **Question:** Are portfolios user-entered/simulated only, or are read-only external account connections in scope?
- **Decision owner:** TBD (product)

### D-017 — Trading partner model and regulatory responsibility boundaries
- **Status:** DEFERRED
- **Needed by:** Phase 5
- **Question:** Which regulated partners execute, custody, or distribute, and where does responsibility sit?
- **Decision owner:** TBD (business + legal)

### D-018 — Legal and custody structure for any tokenized real-world asset
- **Status:** DEFERRED
- **Needed by:** Phase 4
- **Question:** What legal structure, issuer, custody/registration, and redemption rights apply to the pilot asset?
- **Decision owner:** TBD (legal)

---

## 3. Decision process

1. Propose the decision and record options and criteria.
2. Gather evidence (contracts, tests, legal review, benchmarks).
3. Record the outcome, owner, date, and consequences here.
4. Update affected documents and the work queue.
5. Never mark dependent work complete while its decision is `OPEN`.

## 4. Change history

| Date | Change | By |
|---|---|---|
| 2026-11-01 | Register created from architecture §10; D-000 and D-010–D-016 recorded. | Project management |
| 2026-11-01 | D-019 (provisional Frankfurter FX daily reference slice) and D-020 (MVP storage/display policy) recorded; D-001/D-002/D-004/D-008 notes updated. | Project management |
