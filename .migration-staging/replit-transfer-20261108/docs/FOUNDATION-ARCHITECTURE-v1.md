# NEXORA — Foundation Architecture
**Document:** Foundation Architecture & Product Charter  
**Version:** 1.0 (initial baseline)  
**Status:** Approved direction; detailed engineering decisions remain open  
**Date:** 2026-10-31

---

## 1. Executive vision

NEXORA is intended to become a unified financial and digital-asset platform that connects market information, portfolio visibility, trading workflows, and digital-asset ownership and settlement.

The platform's purpose is to make it easier to observe and work with multiple markets through one coherent system, while keeping clear boundaries between:

1. **Market information** — prices, reference data, market status, valuation and history.
2. **Trading and execution** — orders, routing, execution status, broker or exchange integrations and risk controls.
3. **Asset ownership and custody** — the legal and operational rights associated with traditional or tokenized assets.
4. **Blockchain records and settlement** — verifiable on-chain records and settlement logic where blockchain provides a real benefit.

NEXORA is not defined as “a blockchain plus a token.” The blockchain is one infrastructure layer within a broader financial system.

## 2. Product principles

1. **Correctness before speed.** Never present an uncertain, stale or unverified price as authoritative.
2. **Data provenance.** Every market datum must retain its source, timestamp, market/session context, currency, and quality state.
3. **Clear separation of concerns.** Market-data ingestion, pricing, trading, custody, and blockchain settlement are separate subsystems with explicit interfaces.
4. **Off-chain by default for high-volume data.** Raw tick streams, full market histories and frequent price updates belong in suitable off-chain data systems. Only selected, signed and useful attestations or state transitions should be written on-chain.
5. **Simulation before real-money activity.** Early trading workflows are paper/simulated only.
6. **No implied ownership.** A token representation does not automatically create legal ownership, redemption rights, or a claim on an underlying asset.
7. **Security and compliance gates.** Real-money execution, custody, asset issuance and distribution require appropriate legal review, licensed partners where required, and independent security review.
8. **Evidence-based claims.** A feature is not “built,” “secure,” “live,” or “audited” until test results and evidence support that claim.

## 3. Target markets and asset categories

The initial product scope is multi-asset and may include:

- Foreign exchange (FX): currency pairs, bid/ask, reference rates and trading sessions.
- Equities: listed shares, quotes, trades, corporate actions and exchange identifiers where licensed data is available.
- Bonds and fixed income: prices, yields, maturity, coupon, issuer and instrument identifiers where available.
- Hedge funds and alternative funds: reported NAV, performance and reference information when legitimately available. These values may be periodic or delayed and must not be represented as live executable quotes.
- Digital assets: crypto-asset prices, venues, trading pairs, supply/reference information and on-chain identifiers.
- Market indices and benchmarks: index levels and reference values, subject to provider permissions.

Additional classes (such as commodities, options, futures or money-market instruments) are candidates for later phases, not assumed launch scope.

### 3.1 Data availability labels

Every displayed value must be clearly classified, for example:

- REAL_TIME
- DELAYED
- END_OF_DAY
- PERIODIC_NAV
- REFERENCE_ONLY
- INDICATIVE
- STALE
- UNAVAILABLE

A periodic fund NAV must never be presented as a continuously tradable market price. A reference FX rate must not be presented as an executable broker quote.

## 4. High-level architecture

### 4.1 Market Data Hub

Responsibilities:
- Connect to authorized data providers, exchanges, brokers and public reference sources.
- Ingest streaming, polling, batch and end-of-day feeds.
- Retain raw provider payloads or auditable source references where licensing and storage terms permit.
- Normalize instruments, symbols, venues, currencies, units and timestamps.
- Track provider health, entitlement and feed gaps.
- Enforce data licensing and redistribution restrictions.

The Market Data Hub does not execute trades and does not decide legal ownership.

### 4.2 Instrument & Reference Data Service

Responsibilities:
- Maintain canonical instrument identifiers and provider-symbol mappings.
- Capture asset class, issuer, venue, quote currency, trading calendar, tick size, contract multiplier and relevant fixed-income terms.
- Track symbol changes, corporate actions and instrument lifecycle events.
- Prevent ambiguous symbols from being treated as globally unique identifiers.

### 4.3 Pricing & Data Quality Engine

Responsibilities:
- Validate timestamps, sequence numbers, market status and expected update cadence.
- Detect stale, crossed, outlier, duplicated and conflicting observations.
- Compare multiple sources where the product has permission to do so.
- Apply asset-class-specific validation rules.
- Publish price observations with source and quality metadata.
- Preserve the raw observation and record any derived/consolidated calculation.

The engine must not silently manufacture a price when feeds disagree. It should expose the disagreement, downgrade quality, or mark the value unavailable according to defined rules.

### 4.4 Historical Data & Analytics

Responsibilities:
- Store appropriately licensed time-series and reference data.
- Provide charts, return calculations, portfolio valuations and historical comparisons.
- Identify the calculation method, time zone, currency and data completeness.
- Distinguish observed prices from computed metrics and estimates.

### 4.5 Portfolio Service

Responsibilities:
- Provide a unified view of user-entered, simulated, connected and (only when properly supported) custodied positions.
- Track quantity, instrument, cost basis, valuation timestamp, currency and source.
- Show unrealized/realized performance only when the underlying data supports it.
- Clearly label simulated balances versus real assets.

### 4.6 Trading & Order Management Engine

Initial scope:
- Paper trading and order simulation.
- Order lifecycle states, validation, buying-power simulation and fill simulation.
- Risk checks and audit logs.
- Broker/exchange adapters behind a provider-neutral interface.

Future scope:
- Real order routing only through properly authorized and appropriately regulated providers.
- Explicit user authorization, operational controls, reconciliation and incident handling.

The Trading Engine must not be confused with the Market Data Hub. A price feed alone is not an execution venue.

### 4.7 Digital Asset & Tokenization Layer

Responsibilities:
- Model a digital representation of an asset or contractual right only when the issuer, rights, custody/registration arrangements and legal structure are documented.
- Link each token class to authoritative issuance and redemption rules, transfer restrictions and relevant disclosures.
- Maintain reconciliation between token supply and the corresponding legal/operational records where applicable.
- Provide verifiable records without claiming that a blockchain entry alone establishes title to an off-chain asset.

No real-world asset tokenization is launch-ready merely because a token contract can be deployed.

### 4.8 Oracle & Attestation Layer

Responsibilities:
- Relay selected price observations or reference values with signed provenance.
- Include source identity, observation time, publication time, quality status, instrument identity and methodology/version.
- Support freshness thresholds, quorum or source-policy rules, replay protection and signer rotation.
- Halt or mark an asset unavailable when confidence or freshness requirements are not met.

The Oracle is not the primary high-frequency market-data store. It should publish only values needed by on-chain logic, at a cadence appropriate to the asset and use case.

### 4.9 NEXORA Blockchain

Proposed technology direction:
- Cosmos SDK application chain.
- CometBFT consensus.
- Ignite CLI v30 toolchain for scaffolding, subject to environment/toolchain verification.
- IBC integration only after security and interoperability requirements are understood.

Potential responsibilities:
- Native network state and ANEX accounting.
- Validator and governance operations.
- Selected signed oracle observations or attestations.
- Token registry and transfer rules for supported digital assets.
- Settlement and audit-friendly records for workflows designed to use on-chain execution.

The chain should not store every raw market tick or replicate the entire Market Data Hub.

## 5. ANEX — native network token proposal

Current direction: ANEX is proposed as the native token of the NEXORA blockchain.

Potential utility categories for later specification:
- Network fees.
- Validator staking/security participation.
- Protocol governance, if governance is enabled.

The following are **not established** by this document:
- A dollar peg or stable-value promise.
- Backing by reserves or any other asset.
- A right to redeem for shares, bonds, fund units or other property.
- A guaranteed return, yield or investment outcome.
- Final supply, issuance schedule, inflation, reward allocation or fee distribution.

A separate tokenomics specification must define supply accounting, denomination precision, mint/burn permissions, validator rewards, community allocations, fee destinations, governance and upgrade controls. Historical ANEX figures must be reconciled at a common block height before any economic conclusions are accepted.

## 6. Core data model requirements

A normalized market observation should, at minimum, capture:

- instrument_id
- provider_id
- provider_symbol
- asset_class
- venue_or_source
- bid, ask, last, close or the applicable observation fields
- price_currency
- unit_or_contract_multiplier, where relevant
- event_timestamp
- received_timestamp
- published_timestamp, where relevant
- data_status
- quality_flags
- market_session
- source_entitlement or licensing classification
- normalization_version

Do not assume every asset class has bid/ask/last fields. The schema must be extensible by asset type and observation type.

## 7. Security, risk and governance requirements

- Least-privilege service identities and separated signing keys.
- Hardware-backed or managed key custody for production signing where appropriate.
- No private keys or API secrets in source code, logs, screenshots or public repositories.
- Signed, versioned software releases and dependency pinning.
- Independent review of chain modules, oracle logic and token contracts before production.
- Monitoring for feed interruption, stale values, oracle disagreement, abnormal order activity and chain validator health.
- Clear incident response, pause controls and recovery procedures.
- Reconciliation and immutable audit trails for financial state transitions.
- No production assets or real-money trading during initial development.

## 8. Delivery roadmap and acceptance gates

### Phase 0 — Foundation
Deliverables:
- This architecture baseline.
- Instrument taxonomy and canonical data model.
- Provider/licensing matrix.
- Threat model and system trust boundaries.
- Separate ANEX tokenomics workstream.

Acceptance:
- Every subsystem has an owner, interface and explicit non-responsibilities.
- Unresolved assumptions are recorded rather than hidden.

### Phase 1 — Market Data MVP
Deliverables:
- One initial asset category and a small number of authorized providers.
- Ingestion, normalization, quality checks and historical storage.
- Market dashboard and documented read-only API.

Acceptance:
- Source and timestamp are visible for every quote.
- Stale/conflicting data is detected and labeled.
- Provider outages do not silently produce fabricated values.
- Provider licensing allows the intended display and use.

### Phase 2 — Portfolio & Simulation
Deliverables:
- Simulated portfolios.
- Paper orders and simulated fills.
- Valuation and audit trail.

Acceptance:
- Simulated and real positions cannot be confused.
- Reproducible calculations and deterministic test cases exist.
- No real orders or custody are enabled.

### Phase 3 — Blockchain Testnet & Oracle
Deliverables:
- Actual Cosmos SDK source scaffold and pinned dependencies.
- Local development network and multi-validator test environment.
- Oracle message format, signer model and freshness rules.
- On-chain modules only for validated requirements.

Acceptance:
- Reproducible build and passing unit/integration tests.
- Chain initialization and local/testnet smoke tests pass.
- Oracle rejects stale, malformed, replayed and unauthorized observations.
- No Mainnet or real assets.

### Phase 4 — Digital Asset Pilot
Deliverables:
- One narrowly scoped asset representation with documented issuer, rights, custody and lifecycle.
- Supply reconciliation and operational/legal controls.

Acceptance:
- Legal review and required permissions are documented.
- Issuance, transfer, pause and redemption/claim processes are tested.
- Independent smart-contract and operational review is complete.

### Phase 5 — Regulated Integrations
Deliverables:
- Integrations with qualified trading, custody and financial partners where required.
- Production operations, monitoring, reconciliation and compliance controls.

Acceptance:
- Required licenses/partners and jurisdictional approvals are confirmed.
- Security audit, operational readiness and incident drills are complete.
- Production enablement is a separately approved decision.

## 9. Explicit non-goals for the initial release

- No promise of guaranteed profits or investment performance.
- No unlicensed brokerage, custody, exchange or fund-management activity.
- No claim that every asset class has real-time data.
- No unsupported claim of legal ownership through token possession alone.
- No high-frequency raw market-feed storage on the blockchain.
- No Mainnet launch before the relevant test, audit, legal and operational gates are passed.

## 10. Open decisions register

The following require explicit decisions and evidence:

1. First launch jurisdiction and initial user segment.
2. First supported asset class and first authorized data providers.
3. Target latency and acceptable delay by asset class.
4. Data licensing, display, storage and redistribution rights.
5. Initial chain modules and whether IBC is required in the first testnet.
6. Final ANEX supply, precision, issuance and reward policy.
7. Oracle source policy, signer governance and failure thresholds.
8. Portfolio model and whether external account connections are in scope.
9. Trading partner model and regulatory responsibility boundaries.
10. Legal and custody structure for any tokenized real-world asset.

## 11. Current implementation status — 2026-10-31

This is an approved **architecture baseline**, not evidence that the system has already been implemented.

- No verified production Market Data Hub is established by this document.
- No completed trading engine or custody system is established by this document.
- NEXORA chain source has not yet been verified as generated.
- No successful chain build or test result is established here.
- No Mainnet, real-money trading, tokenized real-world asset issuance or live custody is authorized.

All future progress reports must distinguish planned, implemented, tested, reviewed and production-enabled states.

---

**Baseline principle:** NEXORA connects market information, financial workflows and digital-asset infrastructure. Each layer must be independently correct, auditable and appropriately authorized before the next layer depends on it.
