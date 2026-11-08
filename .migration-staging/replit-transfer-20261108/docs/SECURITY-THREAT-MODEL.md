# NEXORA — Security Threat Model

**Version:** 1.0
**Date:** 2026-11-01
**Status:** Design-stage threat model. No controls are implemented or audited.
**Baseline:** [`FOUNDATION-ARCHITECTURE-v1.md`](FOUNDATION-ARCHITECTURE-v1.md)

This document identifies trust boundaries, assets, actors, threats, and required controls. It is a planning artifact, not evidence that any control exists.

---

## 1. Scope

In scope: market-data ingestion and publication, pricing/quality, portfolio and paper-trading services, oracle signing and publication, the Cosmos testnet, token registry logic, operational tooling, and the canonical workspace.

Out of scope for now: Mainnet, real-money execution, real custody, public token sale. These are prohibited until later gates.

## 2. Assets to protect

| Asset | Why it matters |
|---|---|
| Market data integrity | Wrong/stale prices cause financial and trust harm |
| Provider credentials / API keys | Unauthorized access, cost, data misuse |
| Oracle signing keys | Forged on-chain observations |
| Validator keys (testnet) | Consensus integrity |
| User/portfolio data | Privacy and contractual obligations |
| Audit logs | Non-repudiation and reconciliation |
| Token supply records | Economic and legal correctness |
| Legal/licence documents | Regulatory exposure |
| Source code and build artifacts | Supply-chain integrity |

## 3. Trust boundaries

```
[External providers] --(1)--> [Ingestion] --(2)--> [Normalization/Quality] --(3)--> [Store/API]
                                                          |
                                                          +--(4)--> [Oracle signer] --(5)--> [Chain]
[Users] --(6)--> [API/UI] --(7)--> [Portfolio/Paper trading]
[Operators] --(8)--> [Admin/ops tooling] --(9)--> [Keys, deploys, config]
```

| # | Boundary | Trust concern |
|---|---|---|
| 1 | Provider → ingestion | Authenticity, completeness, rate limits |
| 2 | Raw → normalized | Schema abuse, unit/symbol confusion |
| 3 | Quality → publication | Stale/conflicting data leaking as authoritative |
| 4 | Off-chain → oracle | Source policy, signer authorization, replay |
| 5 | Oracle → chain | Message validity, freshness, quorum |
| 6 | User → API | Authn/authz, input abuse, data isolation |
| 7 | API → simulation | Confusion of simulated vs real state |
| 8 | Operator → systems | Least privilege, separation of duties |
| 9 | Tooling → secrets | Key/secret exposure, supply chain |

## 4. Actors

- External data providers and venues.
- End users (retail/professional, depending on D-003).
- Internal operators/administrators.
- Validators (testnet).
- Oracle signers.
- External attackers (opportunistic and targeted).
- Malicious or compromised dependencies.
- Insiders.

## 5. Threat catalogue

### T-01 Spoofed or tampered market data
- **Impact:** False prices drive bad valuations/decisions.
- **Vectors:** Compromised provider, MITM, forged payloads, replay of old messages.
- **Controls:** TLS, authenticated feeds, provider signatures where available, sequence/timestamp checks, replay windows, anomaly detection, source allowlist.

### T-02 Stale data presented as current
- **Impact:** Users act on obsolete values.
- **Vectors:** Feed stall, clock skew, silent reconnect.
- **Controls:** Freshness thresholds per asset class (D-004), heartbeat monitoring, explicit `STALE`/`UNAVAILABLE` states, no interpolation-as-real.

### T-03 Conflicting sources silently reconciled
- **Impact:** Fabricated consensus hides disagreement.
- **Controls:** Preserve raw observations, expose conflict, quality downgrade, documented arbitration policy, no silent fill.

### T-04 Symbol/instrument confusion
- **Impact:** Wrong asset priced or traded.
- **Vectors:** Ambiguous tickers, venue differences, symbol reuse, corporate actions.
- **Controls:** Canonical instrument IDs, provider-symbol mapping, lifecycle events, validation against reference data.

### T-05 Oracle forgery / unauthorized signing
- **Impact:** Corrupted on-chain state.
- **Vectors:** Stolen key, rogue signer, misconfigured permissions.
- **Controls:** Separated signing keys, HSM/managed custody for production, signer allowlist, rotation, quorum, replay protection, monitoring.

### T-06 Oracle replay / stale on-chain value
- **Impact:** Outdated price used by on-chain logic.
- **Controls:** Monotonic nonce/timestamp, freshness window, rejection tests, halt/unavailable behavior (D-006).

### T-07 Key and secret leakage
- **Impact:** Full compromise of feeds, signing, or infrastructure.
- **Vectors:** Secrets in code/logs/screenshots, broad env vars, over-privileged tokens.
- **Controls:** Secret manager, least privilege, no secrets in repo, scanning, rotation, redaction in logs.

### T-08 Unauthorized trading or custody action
- **Impact:** Real financial loss, regulatory breach.
- **Vectors:** Missing authz, confused simulation/real paths, rogue operator.
- **Controls:** Simulation-only until Gate 5, hard feature flags, separation of duties, approval workflows, immutable audit.

### T-09 Simulated vs real state confusion
- **Impact:** Users believe they hold real assets/positions.
- **Controls:** Structural separation, explicit labels, separate identifiers/stores, UI/API warnings, tests that assert non-confusion.

### T-10 Token supply / ownership mismatch
- **Impact:** Unbacked tokens, legal claims, reconciliation failure.
- **Controls:** Supply reconciliation, issuer/rights documentation, mint/burn controls, independent review, no implied ownership.

### T-11 Supply-chain compromise
- **Impact:** Malicious code in build or runtime.
- **Vectors:** Unpinned dependencies, compromised registry, unsigned artifacts.
- **Controls:** Pinning, lockfiles, checksums, signed releases, dependency review, reproducible builds.

### T-12 Log/data privacy leakage
- **Impact:** PII or confidential data exposure.
- **Controls:** Data classification, redaction, retention limits, access control, no secrets/PII in logs.

### T-13 Denial of service / rate-limit abuse
- **Impact:** Outage, cost overrun, stale data.
- **Controls:** Quotas, backoff, circuit breakers, caching within licence terms, alerting.

### T-14 Insider misuse
- **Impact:** Data theft, unauthorized changes, key misuse.
- **Controls:** Least privilege, dual control for sensitive actions, audit trails, access reviews.

### T-15 Chain/validator compromise (testnet → future)
- **Impact:** Consensus failure or manipulated state.
- **Controls:** Key separation, monitoring, upgrade governance, no Mainnet until audit.

### T-16 Unauthorized or over-broad Cloudflare exposure
- **Impact:** A local service becomes reachable outside the machine, exposing data or sensitive routes.
- **Vectors:** Speculative hostname, missing Access policy, Everyone/allow-all policy, public quick tunnel, over-broad port, or exposing admin/write/shell/database/credential/trading endpoints.
- **Controls:** Task-specific named subdomain under `sageswap.dpdns.org`; reuse existing tunnel/resources; read-only inspection first; verified Access application/policy for the exact hostname and service; minimum routes/ports; GET/HEAD-only where possible; no secrets or unnecessary account identifiers in logs; remove task-created resources when no longer needed.

## 6. Required controls by phase

| Phase | Minimum controls |
|---|---|
| 0 | Threat model, secret-handling policy, no-secrets-in-repo rule, least-privilege intent |
| 1 | TLS/auth feeds, provenance validation, freshness/conflict handling, entitlement enforcement, monitoring |
| 2 | Authn/authz, simulation isolation, audit trail, deterministic tests |
| 3 | Signer separation, replay/freshness enforcement, pinned deps, reproducible builds, test evidence |
| 4 | Mint/burn controls, supply reconciliation, pause/recovery, independent review |
| 5 | Production key custody, audits, incident drills, compliance monitoring, separate approval |

## 7. Residual risks (accepted for now)

- No implemented controls exist yet; the system is documentation-only.
- Provider security posture is unknown until D-001 is decided.
- Legal/regulatory risk is unassessed until D-003.
- Toolchain cannot be verified in the current environment, so build integrity is unproven.
- Testnet key management will not match production standards.

## 8. Security gate rule

No phase advances if it would enable real money, custody, issuance, or Mainnet without: completed threat review, implemented controls, independent security review, and explicit approval. A passing test suite alone is not a security audit.
