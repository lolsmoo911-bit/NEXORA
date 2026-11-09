# NEXORA — Data Providers

**Version:** 1.0
**Date:** 2026-11-01
**Status:** Evaluation framework plus one **provisional MVP selection**: Frankfurter v2 blended daily FX reference rates. No contract, production commitment, or final provider decision.

This document defines how NEXORA will choose and govern market-data sources. It does not grant rights to any data and does not name a selected vendor.

---

## 1. Principles

1. **Licence before ingestion.** No feed is connected until display, storage, derived use, and redistribution rights are documented.
2. **One provider, one asset class first.** Phase 1 deliberately limits scope.
3. **Provenance is mandatory.** Every observation retains provider, symbol, venue, timestamps, currency, and quality state.
4. **No silent substitution.** If a provider fails or disagrees, the system exposes staleness/conflict or marks the value unavailable.
5. **Entitlement-aware storage.** Retention and caching follow contract terms, not convenience.
6. **No scraping around terms.** Public availability is not the same as permission.

## 2. Asset-class considerations

| Asset class | Typical data shape | Key risks | Phase 1 candidate? |
|---|---|---|---|
| FX | Bid/ask, reference rates, session hours | Reference vs executable confusion; venue fragmentation | Candidate |
| Equities | Quotes, trades, corporate actions, identifiers | Licensing cost; symbol changes; consolidated vs venue data | Candidate |
| Fixed income | Prices, yields, coupons, maturity, issuer | Sparse/indicative pricing; delayed data | Candidate (harder) |
| Funds / alternatives | Periodic NAV, performance | Must never appear as live tradable price | Candidate (labeling-heavy) |
| Digital assets | Prices, pairs, venues, supply/reference | Venue manipulation; 24/7 sessions; chain reorgs | Candidate |
| Indices / benchmarks | Index levels, methodology | Redistribution restrictions; licensing | Candidate |

Selection of the launch class is **D-002 (open)**.

## 3. Evaluation criteria

Score each candidate against:

| Criterion | What to establish |
|---|---|
| Licence scope | Display, storage, derived data, redistribution, retention period |
| Coverage | Instruments, venues, history depth, reference data |
| Quality | Timestamps, sequence numbers, corrections, known gaps |
| Latency | Real-time / delayed / EOD; measured update cadence |
| Access | API protocol, auth model, rate limits, sandbox |
| Reliability | SLA, uptime history, incident communication |
| Cost | Licence, per-user, per-query, historical, redistribution fees |
| Compliance | Venue permissions, audit rights, data-location rules |
| Integration effort | Mapping complexity, identifier quality, SDK maturity |
| Exit | Data portability, termination terms, cache-deletion obligations |

## 4. Candidate categories and provisional selection

| Category | Examples of type | Status | Notes |
|---|---|---|---|
| Frankfurter v2 | Public keyless reference API | **Provisional MVP selection (D-019)** | Blended daily FX reference; FAQ says blend is free for commercial use and encourages local daily caching/historical analytics; not real-time |
| Licensed exchange feed | Direct venue API/market data agreement | Not evaluated | Strong provenance; per-venue licensing |
| Licensed aggregator/vendor | Commercial reference-data provider | Not evaluated | Broad coverage; higher cost |
| Public reference API | Central-bank/statistical or open-data source | Not evaluated | Must confirm reuse terms; often delayed/EOD |
| Partner-supplied feed | Broker/custodian contractual feed | Not evaluated | Tied to Phase 5 partner model |

Frankfurter is selected only for the first engineering slice (D-019). Final provider selection for Phase 1 remains open (D-001), and per-provider endpoints remain disabled until their terms are reviewed.

### 4.1 Evaluated and not selected

| Provider | Outcome | Reason |
|---|---|---|
| Twelve Data | **Excluded** | Basic individual plans are personal/internal use, not third-party commercial display or redistribution; business use needs appropriate plans/permissions. Terms (updated 2026-01-01) bar under-18 acceptance/use. No account was created and no terms were accepted. |
| Alpha Vantage | **Not selected** | Realtime/intraday US equity feeds are premium; commercial use requires contacting sales. Not a no-cost public-display option. |
| Coinbase public market data | **Not selected** | Terms do not grant a general redistribution licence; displaying/redistributing data requires express consent. |

### 4.2 Frankfurter provider/licensing matrix (factual population, 2026-11-01)

**Status:** Factual/source-backed population only. This does **not** close D-008, grant data rights, or approve retention/redistribution. Evidence note: [`EVIDENCE-FRANKFURTER-PROVIDER-LICENSING-2026-11-01.md`](EVIDENCE-FRANKFURTER-PROVIDER-LICENSING-2026-11-01.md).

| Layer | Scope | Official source | What was actually found | Caching / retention | Redistribution | Last verified |
|---|---|---|---|---|---|---|
| Frankfurter software/code/docs/Docker images | Software artifact | https://frankfurter.dev/license/ | Code, docs, and Docker images are MIT-licensed. This is not a data licence. | Not applicable to rate data | MIT does not grant rate-data redistribution rights | 2026-11-01 |
| Frankfurter v2 blended API (default route) | Blended calculation across providers | https://frankfurter.dev/ FAQ; https://frankfurter.dev/license/ | FAQ: blended rates are Frankfurter's own calculation and free for commercial use; direct provider endpoints remain subject to provider terms. Mid-market; usually daily; some sources are weekly/monthly/quarterly and excluded from the blend. No fixed quotas; anti-abuse rate limiting applies. Not an official institution rate. | FAQ encourages storing daily observations locally for caching or historical analytics. No retention duration is decided here. | Commercial use of the blend is FAQ-stated; third-party redistribution is not stated and remains **D-008 OPEN**. | 2026-11-01 |
| Underlying provider data in the blended feed | Provider records observed in the exact four-quote capture | https://frankfurter.dev/license/#providers; `GET https://api.frankfurter.dev/v2/providers` | Frankfurter does not own the rates and cannot grant provider rights; provider terms apply where published. Exact capture observed 89 provider keys: 39 with a linked Terms entry, 50 with “None published” on the licence page. Six records were `excluded: true` and not blended. | Provider-specific; not reviewed. No conclusion from “None published.” | Provider-specific; no redistribution right inferred. **D-008 OPEN.** | 2026-11-01 |
| Direct provider endpoints (`/v2/providers/{key}/rates`) | Direct provider route, not enabled in MVP | https://frankfurter.dev/ | FAQ: direct queries to individual provider endpoints remain subject to each provider's terms. | Provider-specific; not reviewed | Provider-specific; not approved | 2026-11-01 |
| Bank of Algeria (lookup only) | Provider-terms page entry; **not observed in this capture** | https://frankfurter.dev/license/#providers | Licence-page provider-terms table says **“None published”**. It was not present in the captured four-quote response. | Not reviewed | Not inferred; not proof of public-domain status. **D-008 OPEN.** | 2026-11-01 |

**Four-quote capture facts (documentary only):**

| Item | Fact |
|---|---|
| Exact endpoint | `https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR%2CGBP%2CJPY%2CCHF&expand=providers` |
| Retrieved | `2026-11-01T01:30:39Z` (HTTP 200, four rows) |
| Rows | `USD/CHF` 0.82476; `USD/EUR` 0.89485; `USD/GBP` 0.74793; `USD/JPY` 157.66; all observation date `2026-10-31` |
| Provider records | 89 unique keys appear; 39 linked Terms, 50 “None published”; excluded records: `CBTT` (CHF/EUR/GBP) and `BCC`, `CBG`, `CBM` (JPY) |
| Coverage/cadence caveat | Not every key contributes to every pair. Observed provider dates range `2026-10-22` to `2026-10-31`; provider metadata lists `FRED` as weekly and `BOM` as monthly. Do not infer current contribution from the global provider list or currency coverage. |
| Licence separation | Observed provider-record metadata is not a licence grant. The MIT licence covers software, not data. “None published” is not permission. |

**D-008 remains OPEN.** No redistribution is implemented. The MVP stores blended daily rates locally and displays them only on a localhost page; it is not a redistribution service. Legal/product owner approval is still required where provider terms remain unclear.

## 5. Required provider metadata

Store per provider and per feed:

- `provider_id`, legal entity, contract/version, effective dates.
- Entitled asset classes, venues, instruments, and user segments.
- Permitted operations: display, store, derive, redistribute, cache, retention.
- Latency class and documented update cadence.
- Authentication method and secret-handling reference (never the secret itself).
- Rate limits, quotas, and throttling behavior.
- Status/health endpoint and incident contact.
- Attribution/display requirements.
- Termination and cache-deletion obligations.

## 6. Data-quality rules (Phase 1 baseline)

| Rule | Behavior |
|---|---|
| Missing timestamp | Reject or mark `UNAVAILABLE` |
| Future/implausible timestamp | Flag, quarantine, do not publish |
| Stale beyond threshold | Mark `STALE`; never present as current |
| Duplicate observation | Deduplicate by provider sequence/id |
| Crossed bid/ask | Flag; do not silently "fix" |
| Outlier vs reference | Flag; retain raw; require review |
| Source disagreement | Expose conflict or downgrade quality |
| Provider outage | Explicit `UNAVAILABLE`; no interpolation presented as real |
| Session closed | Label market session; no fake live state |

Thresholds are per asset class and require **D-004**.

## 7. Licensing checklist (Gate 1)

- [ ] Written terms identify permitted display and users.
- [ ] Storage and retention permitted for the chosen design.
- [ ] Derived metrics and redistribution permitted or disabled.
- [ ] Attribution requirements implemented.
- [ ] Non-display/internal-use restrictions honored.
- [ ] Termination/cache-deletion procedure documented.
- [ ] Entitlement metadata stored with observations.

## 8. Open decisions

- **D-001** — final first provider (provisional MVP choice recorded in D-019).
- **D-002** — final first asset class (MVP slice uses FX daily reference only).
- **D-004** — latency/delay targets.
- **D-008** — licensing, storage, display, redistribution.

Until D-001/D-002/D-008 are `DECIDED` for the final product, provider work beyond the provisional slice is **Planned/Blocked**, and no additional feed may be connected.
