# NEXORA — Subsystem Ownership Map

**Version:** 0.1
**Date:** 2026-11-01
**Status:** Role-level governance map. Named individual owners are **TBD**; this document does not assign them.
**Baseline:** [`FOUNDATION-ARCHITECTURE-v1.md`](FOUNDATION-ARCHITECTURE-v1.md)

This map records accountability, logical interfaces, and explicit non-responsibilities for each architecture subsystem. It is a planning artifact, not evidence that any subsystem is implemented or production-ready.

---

## 1. Purpose and scope

Phase 0 requires every subsystem to have an owner, an interface, and explicit non-responsibilities. This document supplies the role-level map. It deliberately does **not** infer named individuals, approve product scope, or resolve open decisions.

Scope:
- The nine architecture subsystems in `FOUNDATION-ARCHITECTURE-v1.md` §4.
- The cross-cutting security, licensing, platform, and governance functions needed to keep those subsystems bounded.
- Decision dependencies that prevent a subsystem from being treated as complete.

Out of scope:
- Implementation detail, staffing plans, budgets, or vendor selection.
- Any Mainnet, real-money trading, custody, token issuance, or public exposure.
- Any claim that Gate 0 has passed.

## 2. Ownership convention

- **Accountable role** is the function accountable for the subsystem boundary. It is not a named person.
- **Named individual owner** is `TBD` for every subsystem until the project owner records an assignment. No assignment is implied by this document.
- A role may own more than one subsystem, but the interfaces and non-responsibilities remain separate.
- A subsystem owner may not enable real-money trading, Mainnet, custody, token issuance, or public exposure without the applicable decision and phase gate.
- Security, legal/licensing, and governance roles may veto or block a change; they do not become product owners by doing so.
- The Cloudflare remote-access capability is not a subsystem. It is an operating capability governed by `README.md` §8 and `SECURITY-THREAT-MODEL.md` T-16. No public route is created by this map.

## 3. Subsystem ownership matrix

| Subsystem | Accountable role | Primary interface | Explicit non-responsibilities | Current state |
|---|---|---|---|---|
| **Market Data Hub** | Data Engineering | Inputs: authorized provider feeds, reference mappings, entitlement metadata. Outputs: auditable raw payload references, normalized observations, provider-health and gap events. | Does not execute trades, decide legal ownership, approve its own licensing rights, or silently fabricate a price. | Local provisional FX slice exists; not a production hub. |
| **Instrument & Reference Data Service** | Data Engineering / Reference Data | Inputs: provider symbols, asset-class definitions, lifecycle and corporate-action events. Outputs: canonical instrument IDs and provider-symbol mappings. | Does not publish prices, execute orders, approve provider terms, or treat a symbol as globally unique. | Not implemented; taxonomy depends on D-002. |
| **Pricing & Data Quality Engine** | Data Engineering / Quality | Inputs: normalized observations, validation rules, freshness thresholds, comparable sources where licensed. Outputs: quality flags, status, conflict/unavailable states, preserved raw observations. | Does not trade, custody assets, invent thresholds, silently replace a conflicting value, or override D-004. | Narrow provisional quality baseline exists; broad engine not complete. |
| **Historical Data & Analytics** | Data Engineering / Analytics | Inputs: quality-approved observations, retention metadata, calculation rules. Outputs: licensed time series, charts, returns, valuations, completeness metadata. | Does not execute trades, redistribute beyond D-008, or present computed metrics as observed prices. | Local SQLite store exists for the provisional slice; retention policy open. |
| **Portfolio Service** | Product / Portfolio Engineering | Inputs: user-entered or simulated positions, instrument references, valuations and timestamps. Outputs: portfolio views, cost basis, performance, simulated/real labels. | Does not custody assets, connect real accounts without D-009, route orders, or imply that a simulated balance is real. | Not implemented; depends on Gate 1 and D-009. |
| **Trading & Order Management Engine** | Simulation Engineering | Inputs: paper orders, simulated balances, risk rules, instrument references. Outputs: simulated order lifecycle, fills, cancellations, audit trail. | Does not route real orders, custody funds, connect an exchange/broker, or enable Mainnet/real-money execution. | Not implemented; paper-only scope is planned. |
| **Digital Asset & Tokenization Layer** | Tokenization Product + Legal | Inputs: documented issuer/rights, custody/registration arrangements, issuance/redemption rules. Outputs: token-class definitions, transfer restrictions, supply reconciliation, disclosures. | Does not create legal title, issue or sell tokens, custody real assets, or deploy to Mainnet without separate approval. | Deferred; depends on Gate 3, D-003, D-018. |
| **Oracle & Attestation Layer** | Oracle Engineering + Security | Inputs: selected observations, source policy, signer policy, freshness/replay rules. Outputs: signed attestations, halt/unavailable signals, provenance metadata. | Does not store raw high-frequency ticks, execute trades, custody signing keys, or publish without a defined source/signer policy. | Not implemented; depends on D-006. |
| **NEXORA Blockchain** | Chain Engineering + Platform | Inputs: Cosmos SDK modules, oracle attestations, token-registry rules, governance operations. Outputs: testnet state, signed records, audit-friendly settlement records. | Does not replicate the Market Data Hub, store every tick, hold real assets, custody funds, or run Mainnet. | Not generated; blocked by environment/toolchain. |
| **Security & Key Management** | Security | Inputs: threat model, key policy, incident reports, dependency and access reviews. Outputs: controls, key-custody procedures, review evidence, incident response. | Does not own product features, grant legal approval, or claim production readiness without evidence. | Threat model documented; controls not implemented or audited. |
| **Data Licensing & Compliance** | Legal + Data Governance | Inputs: provider terms, contracts, retention rules, intended display/use. Outputs: entitlement classifications, licensing matrix, retention/redistribution constraints. | Does not implement feeds, select the final provider (D-001), or silently decide D-008. | Framework and provisional Frankfurter notes exist; final matrix open. |
| **Platform Engineering & CI** | Platform Engineering | Inputs: source, pinned dependencies, environments, test commands. Outputs: reproducible build/test evidence, environment status, release artifacts. | Does not own product logic, bypass identity controls, install around blockers, or approve production enablement. | Python slice testable; chain toolchain blocked. |
| **Governance & Documentation** | Project Management | Inputs: decisions, evidence, work queue, status reports. Outputs: governance docs, decision log, status, queue updates, traceability. | Does not implement subsystems, substitute for an owner decision, or mark work done without evidence. | Active; this map is a new artifact. |

## 4. Interface rules

1. Every cross-subsystem handoff must carry source identity, timestamps, instrument identity, quality/status, and entitlement metadata where applicable.
2. The Market Data Hub may supply observations, but it is not an execution venue.
3. The Quality Engine may downgrade or mark data unavailable; it must not silently repair a conflicting value.
4. The Historical store may serve licensed analytics; it must not become a redistribution service without D-008 approval.
5. The Portfolio Service may value simulated positions; it must not imply custody or real ownership.
6. The Trading Engine may simulate orders; it must not route real orders or hold funds.
7. The Oracle may publish selected attestations; it must not become the primary market-data store.
8. The Blockchain may record selected state; it must not replicate raw market ticks or hold real assets.
9. Security and legal/licensing roles may block a release; they do not inherit product ownership by doing so.
10. Any remote endpoint exposed through Cloudflare must first satisfy the exact-hostname Access verification rule; no subsystem may bypass it.

## 5. Decision dependencies and open ownership

| Dependency | Affected subsystems | Status | Consequence |
|---|---|---|---|
| D-001 first provider | Market Data Hub, Reference Data, Quality, Historical, Licensing | **OPEN** | Final provider work is blocked; provisional Frankfurter slice remains engineering-only. |
| D-002 first asset class | Reference Data, Quality, Historical, Portfolio, Oracle | **OPEN** | Canonical taxonomy and broad quality rules cannot be finalized. |
| D-004 latency/delay | Quality, Historical, Oracle | **OPEN** | The 4-day freshness threshold remains provisional. |
| D-008 licensing/retention/redistribution | Market Data Hub, Historical, API/UI, Licensing | **OPEN** | No redistribution service; retention policy cannot be finalized. |
| D-006 oracle policy | Oracle, Blockchain | **OPEN** | Oracle message/signer/freshness rules remain planned. |
| D-007 IBC necessity | Blockchain | **OPEN** | IBC integration remains deferred. |
| D-009 portfolio connections | Portfolio | **DEFERRED** | No external account connections. |
| D-017 trading partner model | Trading | **DEFERRED** | No real order routing or partner integration. |
| D-018 tokenization legal structure | Digital Asset | **DEFERRED** | No token issuance or real-world-asset pilot. |
| Named individual owners | All subsystems | **BLOCKED / awaiting owner** | Role-level accountability exists; named assignments are not inferred. |

## 6. Gate 0 status

- Role-level ownership, interfaces, and non-responsibilities are documented.
- Named individual owner assignments are **not** made.
- Canonical instrument taxonomy, canonical observation schema, populated licensing matrix, and the ANEX tokenomics charter remain incomplete.
- **Gate 0 is not passed.** This document must not be cited as evidence that it is.

## 7. Change history

| Date | Change |
|---|---|
| 2026-11-01 | Initial role-level map created; named individuals left TBD; open decisions recorded as dependencies. |
