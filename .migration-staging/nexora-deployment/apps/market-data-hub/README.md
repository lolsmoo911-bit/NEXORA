# NEXORA Market Data Hub — MVP slice

Read-only FX **daily reference rate** service using the public Frankfurter v2 API. Python 3.10+ standard library only.

> **Daily reference rate — not a live executable quote and not trading advice.**

## Scope

- Provider: Frankfurter v2, default **blended** route.
- Base `USD`; quotes `EUR`, `GBP`, `JPY`, `CHF` by default.
- Data status: `DAILY_REFERENCE`; price type: `MID`; executable: `false`.
- Local SQLite store under `var/` (gitignored).
- HTTP server binds `127.0.0.1` only.
- Endpoints: `GET /health`, `GET /api/v1/fx/rates`, `GET /api/v1/quality/summary`, `GET /api/v1/providers/health`, `GET /api/v1/quality/gaps`, static UI at `/`.
- Quality labels: `FRESH`, `STALE`, `FUTURE_DATE`, `UNKNOWN`, computed on read from each row's observation date. The provisional threshold is 4 calendar days, which allows weekends but not a universal holiday calendar.
- Provider health records explicit one-shot fetch attempts only. There is no scheduler, polling loop, or internet-status assertion.
- Gap visibility uses `POTENTIAL_WEEKDAY_GAP` only; weekends are skipped, holidays can create false positives, and missing rates are never interpolated.
- No order, trade, custody, account, or provider-key endpoints.

## Requirements

- Python 3.10+ (verified with 3.13.7).
- No third-party packages, no pip install, no API key.

## Run

From `apps/market-data-hub/`:

```powershell
python run.py fetch
python run.py serve
```

`fetch` performs one live request, validates the payload, and upserts rows. `serve` starts a local-only server at `http://127.0.0.1:8000/` (foreground; stop with Ctrl+C).

Options:

```powershell
python run.py fetch --base USD --quotes EUR,GBP,JPY,CHF --db var/nexora_market_data.db
python run.py serve --port 8000
python run.py list
```

### Safe replay and audit commands (scratch databases only)

`replay-local` and `audit-events` are local developer commands. Both require an explicit `--db` path and refuse the application `var/` directory, including `var/nexora_market_data.db`. **Use a separate scratch database; never point these commands at the MVP database.** They do not fetch, use the network, or print rates or raw payloads.

```powershell
python run.py replay-local --db .\.scratch\replay.db
python run.py replay-local --db .\.scratch\replay.db --fixtures tests\fixtures\replay
python run.py audit-events --db .\.scratch\replay.db
python run.py audit-events --db .\.scratch\replay.db --max-errors 100
```

`replay-local` journals the checked-in synthetic fixtures and prints counts only; rerunning the same fixtures reports duplicates. `audit-events` opens SQLite in read-only `mode=ro` mode, prints compact counts plus safe row IDs and error codes only, and performs no schema migration, backfill, repair, or deletion. If the database schema is too old for the audit it fails safely with a sanitized error; migrate such a database only through the approved normal application command, never through `audit-events`. `--max-errors` defaults to 100 and must be between 1 and 1000.

## Tests

```powershell
python -m unittest discover -s tests -t . -v
python -m compileall -q src run.py
```

Tests use mocked provider payloads and temporary databases. No network access is used in unit tests. The current suite contains 89 tests, including 13 event-journal tests, 8 replay-journal integration tests, 4 event-quality audit tests, 8 CLI tests, and 3 read-only Store tests. Latest verification on 2026-11-02: `python -m unittest tests.test_store -v` (7/7, exit 0), `python -m unittest tests.test_cli -v` (8/8, exit 0), `python -m unittest tests.test_event_quality -v` (4/4, exit 0), `python -m unittest discover -s tests -t . -v` (`Ran 89 tests in 6.169s`, exit 0), and `python -m compileall -q src run.py` (exit 0). Earlier validation: `logs/quality-final-tests-20261101-003212.txt` (43/43, exit 0) and `logs/quality-final-compile-20261101-003221.txt` (`compileall`, exit 0).

## Deterministic replay (simulation/testing only)

`src/nexora_market_data/ingestion.py` defines a provider-neutral `IngestionBatch` and `ProviderSource` contract. `ReplaySource` reads explicitly supplied local JSON fixtures, parses numbers as `Decimal`, hashes the exact fixture bytes, and emits batches in deterministic sequence order. `FrankfurterSource` is a thin mapping of the existing `FetchResult`; it does not change fetch behavior.

Replay is **deterministic simulation/testing only**:

- It has no connection to a live market stream, scheduler, or stream consumer.
- It makes no real-time latency claim and does not prove production real-time behavior.
- Fixtures under `tests/fixtures/replay/` are synthetic, not live provider data.
- Only fixture files/directories beneath the configured replay root are accepted; path traversal and symlink escapes are rejected.
- Replay batches reuse the existing normalizer; the daily `fx_rates` schema and existing API remain unchanged; the separate replay journal has its own additive schema.

D-001 (provider), D-002 (asset class), D-004 (real-time), D-008 (retention), and jurisdiction remain unresolved. No decision is inferred.

## Layout

```
apps/market-data-hub/
├── run.py
├── README.md
├── .gitignore
├── src/nexora_market_data/
│   ├── __init__.py
│   ├── provider_frankfurter.py
│   ├── ingestion.py
│   ├── events.py
│   ├── event_quality.py
│   ├── replay_journal.py
│   ├── normalizer.py
│   ├── quality.py
│   ├── store.py
│   ├── api.py
│   └── cli.py
├── tests/
│   ├── __init__.py
│   ├── test_provider.py
│   ├── test_ingestion.py
│   ├── test_events.py
│   ├── test_event_quality.py
│   ├── test_replay_journal.py
│   ├── test_normalizer.py
│   ├── test_quality.py
│   ├── test_store.py
│   ├── test_cli.py
│   ├── test_api.py
│   └── fixtures/
│       └── replay/
│           ├── batch-001.json
│           └── batch-002.json
└── web/
    ├── index.html
    ├── app.js
    └── styles.css
```

## Replay-only event journal (experimental)

The additive `market_data_events` table is a separate journal for **synthetic replay events only** that is append-only in the normal application write path: UPDATE is blocked, and DELETE is reserved for controlled maintenance under a future D-008-compliant retention policy. No API or automatic deletion exists. It does not change the daily `fx_rates` table or the existing API/CLI contracts.

`src/nexora_market_data/replay_journal.py` provides `journal_replay(source, store)`. It accepts a provider-neutral source, rejects any batch whose `is_replay` is not `True` or whose `transport` is not `replay` before writing anything, normalizes payloads with the existing normalizer and raw provenance, and appends replay events. Live/HTTP Frankfurter batches and commercial-provider data are never journaled.

- Canonical event identity is replay provider + `instrument_id` + observation date, for example `replay:FX:USD/EUR:2026-10-30`. The raw batch SHA-256 is provenance, not part of the event ID.
- Identical fixture reruns are idempotent. A changed rate or changed source hash for the same canonical identity raises a conflict instead of overwriting.
- `instrument_id` is `FX:{BASE}/{QUOTE}`.
- The sequence is a local, date-derived ordinal (`observation_date.toordinal()`), scoped by replay provider and instrument. It is labeled `sequence_kind='LOCAL_REPLAY_ORDER'`; it is not a provider-issued or globally contiguous sequence.
- The event timestamp is synthetic observation-date midnight UTC and is labeled as such in the payload. The received timestamp is the deterministic `ReplaySource` simulation time, not wall-clock receipt time; the exact canonical UTC value is stored in both the row and payload and cross-checked by the audit.
- Payload JSON preserves decimal rate text without float conversion and includes observation fields, provenance, replay markers, and timestamp-kind markers. The compact return value reports batches read, observations journaled, inserted, and duplicates; it does not return raw payloads.
- Repeated event IDs with the same instrument, sequence, event time, payload, and provenance are idempotent; the first receipt timestamp and source provenance are retained.
- Reusing an event ID with different content, reusing a local replay sequence for a different event, or changing provenance for the same identity is rejected.
- Out-of-order arrivals are retained; reads return local sequence order. A batch is atomic if a conflict occurs.
- SQLite UPDATE on this journal is rejected. DELETE is intentionally **not** blocked because D-008 retention is unresolved and per-provider terms may require deletion. No public delete endpoint, API/CLI path, or automatic cleanup exists; cleanup must be handled by a future retention policy consistent with data rights.
- `Store.list_events` requires `provider_id` and `instrument_id` together. `after_sequence` filters only that instrument.
- The journal is not connected to a live feed, scheduler, websocket, trading workflow, or public API. It makes no real-time performance claim.
- The event envelope is provisional and does not finalize NEXORA's canonical instrument taxonomy or data schema.

### Read-only event integrity audit

`Store.audit_events(max_errors=100)` and `src/nexora_market_data/event_quality.py` provide a **read-only, local, replay-only** integrity audit. It streams stored rows without writing, repairing, migrating, or deleting anything, handles an empty journal, and returns `scanned`, `valid`, `invalid`, a bounded `errors` list, `errors_truncated`, and `max_errors`. `max_errors` defaults to 100 and is capped at 1000. The `audit-events` CLI opens the database with `Store(..., read_only=True)` using SQLite `mode=ro`, so schema setup and backfill cannot run; an outdated schema fails safely instead of being migrated.

- Audit checks valid envelope JSON, `is_replay`, `sequence_kind`, row/payload provider and instrument identity, `FX:{BASE}/{QUOTE}` form, finite positive Decimal rate text, raw SHA-256 and byte provenance, synthetic midnight UTC event time, the replay simulation received timestamp matched between the row and payload, date-ordinal sequence, and canonical event ID.
- Payload JSON must be an object with unique keys; duplicate keys and `NaN`/`Infinity` constants are rejected.
- Audit results identify rows by a validated non-negative integer `event_row_id` plus field error codes only. They never echo `event_id`, rate values, raw payloads, hashes, endpoints, or secrets. The audit only reports defects; it does not repair them.
- The audit is not connected to a network, live provider, scheduler, stream, API/CLI endpoint, trading, broker, account, custody, token, or chain workflow.

## Data handling

- Rates parsed with `decimal.Decimal`; no float arithmetic.
- Dedup key: `(provider_id, base, quote, observation_date)`.
- Each row stores source, observation date, included and excluded provider keys, complete provider contribution objects (`key`, `date`, `rate`, `excluded`), provider metadata status, `received_at`, status, endpoint, and raw payload.
- Provider arrays that are missing, null, or empty are stored as `NOT_PROVIDED_OR_PEGGED`; this is an explicit ambiguity, not an assumption that no providers contributed.
- Future-dated rows are rejected at ingestion when an `as_of` date is supplied; they are not stored as valid observations.
- Direct provider filters are not enabled until provider terms are reviewed.

## Quality, provider health, and gaps

- Quality is computed on read, not persisted. `GET /api/v1/fx/rates` adds `quality_status`, `age_days`, and `quality_reason` to each row.
- `GET /api/v1/quality/summary` returns fresh/stale/future/unknown counts, latest observation and receipt dates, and the provisional threshold.
- `GET /api/v1/providers/health` returns the latest recorded attempt and trailing consecutive failures. It is based only on explicit fetch attempts recorded by the CLI; no background polling exists.
- `GET /api/v1/quality/gaps?limit=100` reports capped `POTENTIAL_WEEKDAY_GAP` entries between stored observations for the same pair. It skips weekends but has no holiday calendar, so bank holidays can appear as false gaps. Missing rates are not fabricated.
- Provider attempts are stored in `provider_fetch_attempts` with provider, endpoint, timestamps, duration, HTTP status, outcome, rows fetched, and sanitized error class/message.

## Known limitations

- Not production-ready, not real-time, and not an executable quote feed.
- The 4-calendar-day freshness threshold is provisional and allows weekends; provider holidays can still produce false `STALE` flags. D-004 remains open.
- Outlier detection is deferred until comparable provider series or a historical baseline exists; no thresholds are invented for the blended series.
- Provider health reflects only recorded one-shot attempts and does not assert general internet or provider availability.
- Gap detection is weekday-only and does not know bank holidays; a reported gap is possible, not confirmed.
- No redistribution service is implemented. D-008 remains open.

## Non-goals

No real-time/executable quotes, no trading signals, no accounts, no secrets, no redistribution service, no Mainnet, no chain code.
