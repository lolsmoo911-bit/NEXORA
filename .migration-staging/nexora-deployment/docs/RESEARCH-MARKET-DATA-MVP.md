# NEXORA — Market Data MVP Research

**Date:** 2026-11-01
**Status:** Research complete for the first slice; provisional engineering decision recorded. Not a final product, legal, or commercial decision.
**Baseline:** [`FOUNDATION-ARCHITECTURE-v1.md`](FOUNDATION-ARCHITECTURE-v1.md)
**Scope:** Public, read-only market-reference data only. No accounts, keys, trading, or redistribution beyond permitted use.

---

## 1. Purpose

Phase 1 requires **one permitted provider and one asset class** before implementation. This document records the provider research, the licensing constraints found, and the provisional choice used for the first working slice.

The slice is intentionally narrow: daily FX reference rates, stored locally, displayed with attribution and an explicit non-executable label.

## 2. Method

- Reviewed public documentation and terms pages only.
- Created no accounts, accepted no terms, used no API keys, and connected no broker/exchange account.
- Confirmed the Frankfurter v2 response shape with one public GET request.
- No data was redistributed; the local store is for development and evaluation.

## 3. Provider findings

### 3.1 Frankfurter v2 — selected for the MVP slice

| Attribute | Finding |
|---|---|
| Cost / key | Free, no API key required |
| Coverage | Site states 228 currencies and 106 central-bank/official sources; history to 1948 |
| Cadence | Daily rates (some sources weekly/monthly/quarterly and excluded from the blend) |
| Endpoints | `/v2/rates` with `base`, `quotes`, `date`, `from`/`to`, `group`, `providers`, `expand=providers`; also `/v2/rate/{base}/{quote}` |
| Default semantics | Rates are **blended across providers** by Frankfurter; mid-market, not bid/ask |
| Commercial use | FAQ: blended rates are Frankfurter's own calculation and free for commercial use |
| Storage | FAQ encourages local daily caching/historical analytics for daily observations |
| Limits | No quotas; requests rate-limited to prevent abuse |
| Fitness | FAQ: not built for live trading or exotic intraday movements |
| Licence | Software is MIT; underlying data remains owned by providers and provider terms still apply; API/data without warranty |

**Observed response shape (public GET, 2026-11-01):**

```json
[
  {
    "date": "2026-10-31",
    "base": "USD",
    "quote": "EUR",
    "rate": 0.89485,
    "providers": [
      {"key": "ECB", "date": "2026-10-30", "rate": 0.89509},
      {"key": "IMF", "date": "2026-10-30", "rate": 0.89509}
    ]
  }
]
```

Key implications:
- The top-level object is an **array of pair rows**, not a `rates` map.
- `providers` is present only with `expand=providers`; pegged-currency rows may omit it.
- Provider entries may include `excluded: true` when a source was excluded from the blend.
- `rate` is a JSON number; the implementation parses it as `Decimal`, never float.

### 3.2 Twelve Data — not used

- Advertises a Basic tier with **8 API credits / 800 daily** and real-time US equities/FX/crypto.
- Individual plans are described as **personal/internal use**, not third-party commercial display or redistribution; business use requires appropriate plans/permissions.
- Terms (last updated **2026-01-01**) state a person under 18 must not accept or use the platform.
- **Decision:** do not create an account, accept terms, or use this provider for the MVP.

### 3.3 Alpha Vantage — not used

- Broad API catalogue, but realtime/intraday US equity feeds are **premium**, and commercial use requires contacting sales.
- Not a no-cost public-display MVP choice.

### 3.4 Coinbase public market data — not used

- Public market-data APIs do **not** grant a general redistribution licence.
- Terms restrict redistributing or displaying data without express consent.
- **Decision:** do not use these feeds in this MVP.

## 4. Comparison

| Provider | Key required | Asset coverage | Commercial display | Storage | MVP use |
|---|---|---|---|---|---|
| Frankfurter v2 | No | FX daily reference | Blended rates free for commercial use | FAQ encourages local daily caching/historical analytics | **Yes — FX daily reference** |
| Twelve Data | Yes | Equities/FX/crypto | Personal/internal on Basic; business plans needed | Per plan | No |
| Alpha Vantage | Yes | Broad, realtime premium | Contact sales | Per terms | No |
| Coinbase | Varies | Crypto | No general redistribution | Restricted | No |

## 5. Provisional MVP decision

**Selected slice:** Foreign-exchange **daily reference rates**, not executable quotes and not a trading signal.

- Provider: Frankfurter v2, **default blended route**.
- Base: `USD`.
- Quotes: `EUR`, `GBP`, `JPY`, `CHF` (small fixed set).
- Request: `GET https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR,GBP,JPY,CHF&expand=providers`
- Label every observation: `DAILY_REFERENCE` / `MID` / `NON_EXECUTABLE`.
- Store: provider attribution, observation date, contributing provider keys, source, `received_at`, status.
- Never describe the values as real-time, live, executable, bid, or ask.
- Direct-provider filters (`providers=...`) are **disabled** until each source's own terms are reviewed. The default blend is Frankfurter's calculation.

This is an **engineering decision for the first slice**, not financial advice, not a final product-market decision, and not a commitment to FX as the long-term launch class (D-002 remains open).

## 6. Data semantics and labeling

| Field | Value / rule |
|---|---|
| `data_status` | `DAILY_REFERENCE` |
| `price_type` | `MID` |
| `executable` | `false` |
| `source_name` | `Frankfurter v2 (blended daily reference)` |
| `observation_date` | Provider `date` (YYYY-MM-DD), not the fetch time |
| `received_at` | UTC timestamp when NEXORA fetched it |
| `provider_keys` | Contributing provider keys from `expand=providers`, excluding `excluded: true` |
| Dedup key | (`provider_id`, `base`, `quote`, `observation_date`) |
| Rate type | `Decimal`, stored as text, no float arithmetic |

Display notice (required in UI and API): **"Daily reference rate — not a live executable quote and not trading advice."**

## 7. Licensing and attribution handling

- Display "Source: Frankfurter v2 — blended daily reference rates" and the observation date.
- Preserve contributing provider keys for traceability.
- Do not imply provider endorsement.
- Do not enable per-provider queries or redistribution until provider terms are reviewed.
- Keep the raw response locally for audit; do not publish a public data feed.
- Frankfurter software is MIT; underlying data rights remain with providers, and the API is without warranty. The MIT licence does not license rate data.
- Provider-record evidence for the exact four-quote capture is recorded in [`EVIDENCE-FRANKFURTER-PROVIDER-LICENSING-2026-11-01.md`](EVIDENCE-FRANKFURTER-PROVIDER-LICENSING-2026-11-01.md). “None published” is not permission.

## 8. First working slice

Implementation lives in [`apps/market-data-hub/`](../apps/market-data-hub/). Constraints:

- Python 3.10+ standard library only (`urllib`, `json`, `sqlite3`, `decimal`, `http.server`, `unittest`).
- SQLite under local `var/` (gitignored); no secrets.
- HTTP server binds `127.0.0.1` only.
- Read-only endpoints: `/health`, `/api/v1/fx/rates`, `/api/v1/quality/summary`, `/api/v1/providers/health`, `/api/v1/quality/gaps`.
- Static page shows pairs, rate date, quality status, attribution, and the non-executable notice.
- No order, trade, custody, or account endpoints.
- Unit tests use mocked provider payloads; no network in tests.
- One live fetch is run manually and recorded; no background service is left running.

## 9. Validation plan

- Normalization: valid payload → Decimal rates, correct labels, attribution.
- Invalid currency, non-numeric/negative rate, invalid date, malformed payload → rejected with a clear error.
- Duplicate upsert: same dedup key updates in place, no duplicate row.
- Provider attribution persisted and returned.
- API: `/health` and `/api/v1/fx/rates` return expected fields and disclaimer; non-GET rejected.
- All tests must pass before claiming the slice works.

## 10. Explicit non-goals

- No executable FX quotes, bid/ask, or trading signals.
- No equities, bonds, hedge-fund NAV, or crypto in this slice (remain planned).
- No accounts, API keys, broker/exchange connections, orders, or custody.
- No Mainnet, chain source, token issuance, or deployment.
- No public tunnel or Git push.
- No claim of real-time data.

## 11. Open questions

- **D-002:** Is FX the eventual launch asset class, or only the first engineering slice?
- **D-004:** What freshness/delay thresholds apply to daily reference data vs future feeds?
- **D-008:** What retention/redistribution rights apply if NEXORA later displays data to third parties?
- Whether a provider with executable quotes is needed for Phase 2 paper trading (simulation can use reference rates with explicit labeling).

## 12. Sources (accessed 2026-11-01)

- Frankfurter home/API docs: https://frankfurter.dev/
- Frankfurter licence: https://frankfurter.dev/license/
- Frankfurter source: https://github.com/lineofflight/frankfurter
- Twelve Data pricing: https://twelvedata.com/pricing
- Twelve Data commercial/personal usage: https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage
- Twelve Data terms: https://twelvedata.com/terms
- Alpha Vantage documentation: https://www.alphavantage.co/documentation/
- Coinbase market-data terms: https://www.coinbase.com/legal/market_data

## 13. Addendum — quality, provider health, and gap visibility (2026-11-01)

Official Frankfurter v2 documentation reviewed at https://frankfurter.dev/ and https://frankfurter.dev/license/ confirms:

- Latest rates may be prior business-day observations. Each row's `date` is authoritative; do not assume the response date equals the current date.
- `expand=providers` returns provider contribution records with `key`, provider observation `date`, `rate`, and optional `excluded=true`. Excluded records were omitted from the blended rate (outlier filter or peg override). Peg-synthesized rows may omit the provider array.
- The default route blends provider rates. Blended values are Frankfurter's own calculation, not official rates from a single institution. Underlying source terms still apply; rates can be delayed, missing, or revised.

Implementation consequences in this slice:

- Provider contributions are preserved as objects (`key`, `date`, `rate`, `excluded`); included and excluded keys are separated. Missing, null, or empty provider arrays are labeled `NOT_PROVIDED_OR_PEGGED` and documented as ambiguous, not silently treated as zero contributors.
- Freshness is computed on read from each row's observation date, never `received_at`. The provisional threshold is 4 calendar days, which allows ordinary weekends; provider holidays can still produce false `STALE`. There is no universal market calendar. **D-004 remains OPEN.**
- Status taxonomy: `FRESH`, `STALE`, `FUTURE_DATE`, `UNKNOWN`. Future-dated rows are rejected at ingestion when an `as_of` date is supplied; the evaluator still surfaces `FUTURE_DATE` defensively for previously stored or clock-skewed data.
- Outlier thresholds are not invented for a single blended series. Outlier checks remain deferred until comparable provider series or a historical baseline exists. Frankfurter's `excluded` flag is surfaced as metadata, not recomputed.
- Possible missing weekdays are labeled `POTENTIAL_WEEKDAY_GAP`; weekends are skipped, holidays can create false positives, output is capped, and missing rates are never fabricated or interpolated. One observation cannot establish a gap.
- Provider health records only explicit one-shot fetch attempts (provider, endpoint, timestamps, duration, HTTP status, outcome, rows, safe error class/message). There is no scheduler or polling, and the health endpoint does not assert internet status.
- **D-008 remains OPEN.** No redistribution is implemented; the service remains local-only and read-only.

Sources: https://frankfurter.dev/ and https://frankfurter.dev/license/ (accessed 2026-11-01).

## 14. Addendum — provider/licensing evidence note (2026-11-01)

The factual provider/licensing review for the provisional four-quote MVP is stored in [`EVIDENCE-FRANKFURTER-PROVIDER-LICENSING-2026-11-01.md`](EVIDENCE-FRANKFURTER-PROVIDER-LICENSING-2026-11-01.md). It records:

- Frankfurter software/code/docs/Docker images are MIT-licensed; the MIT licence does not cover rate data.
- The FAQ says blended rates are Frankfurter's own calculation and free for commercial use; local daily caching/historical analytics is encouraged; direct provider endpoints remain subject to each provider's terms.
- The exact four-quote capture (`USD` base; `EUR`, `GBP`, `JPY`, `CHF` quotes; `expand=providers`) observed 89 provider keys: 39 with a linked Terms entry and 50 with “None published” on the official licence page. Six records were `excluded: true` and were not blended.
- Bank of Algeria is recorded separately as a licence-page lookup with the exact status **“None published”**; it was **not observed** in the captured four-quote response. The status is not a grant of rights or proof of public-domain status.
- **D-008 remains OPEN.** No retention or redistribution policy is decided, no provider filtering is enabled, and no redistribution service exists. Legal/product owner approval is still required where terms remain unclear.
