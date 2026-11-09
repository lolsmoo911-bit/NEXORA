"""SQLite store for normalized FX reference observations and provider attempts."""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .event_quality import DEFAULT_MAX_ERRORS, audit_event_rows
from .events import (
    LOCAL_REPLAY_SEQUENCE_KIND,
    MarketDataEvent,
    MarketDataEventConflict,
)
from .normalizer import (
    PROVIDER_METADATA_NOT_PROVIDED,
    PROVIDER_METADATA_PROVIDED,
    NormalizationError,
    Observation,
    parse_provider_contributions,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS fx_rates (
    provider_id              TEXT NOT NULL,
    base                     TEXT NOT NULL,
    quote                    TEXT NOT NULL,
    observation_date         TEXT NOT NULL,
    rate                     TEXT NOT NULL,
    data_status              TEXT NOT NULL,
    price_type               TEXT NOT NULL,
    executable               INTEGER NOT NULL,
    source_name              TEXT NOT NULL,
    attribution              TEXT NOT NULL,
    provider_keys            TEXT NOT NULL,
    excluded_provider_keys   TEXT NOT NULL DEFAULT '[]',
    provider_contributions   TEXT NOT NULL DEFAULT '[]',
    provider_metadata_status TEXT NOT NULL DEFAULT 'NOT_PROVIDED_OR_PEGGED',
    received_at              TEXT NOT NULL,
    endpoint                 TEXT NOT NULL,
    raw_json                 TEXT NOT NULL,
    raw_payload_sha256       TEXT,
    raw_payload_bytes        INTEGER,
    normalization_version    TEXT,
    schema_version           TEXT,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    PRIMARY KEY (provider_id, base, quote, observation_date)
);
CREATE INDEX IF NOT EXISTS idx_fx_rates_date ON fx_rates (observation_date DESC);

CREATE TABLE IF NOT EXISTS provider_fetch_attempts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id   TEXT NOT NULL,
    endpoint      TEXT NOT NULL,
    attempted_at  TEXT NOT NULL,
    completed_at  TEXT NOT NULL,
    duration_ms   INTEGER NOT NULL,
    http_status   INTEGER,
    outcome       TEXT NOT NULL CHECK (outcome IN ('OK', 'ERROR')),
    rows_fetched  INTEGER NOT NULL DEFAULT 0,
    error_class   TEXT,
    error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_provider_attempts
    ON provider_fetch_attempts (provider_id, id DESC);

-- Separate, replay-only event journal. Daily fx_rates remains unchanged.
CREATE TABLE IF NOT EXISTS market_data_events (
    event_row_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id           TEXT NOT NULL,
    event_id              TEXT NOT NULL,
    instrument_id         TEXT NOT NULL,
    sequence              INTEGER NOT NULL CHECK (sequence >= 0),
    sequence_kind         TEXT NOT NULL DEFAULT 'LOCAL_REPLAY_ORDER'
                          CHECK (sequence_kind = 'LOCAL_REPLAY_ORDER'),
    event_timestamp       TEXT NOT NULL,
    received_timestamp    TEXT NOT NULL,
    payload_json          TEXT NOT NULL,
    source_payload_sha256 TEXT NOT NULL,
    source_payload_bytes  INTEGER NOT NULL CHECK (source_payload_bytes >= 0),
    is_replay             INTEGER NOT NULL CHECK (is_replay = 1),
    stored_at             TEXT NOT NULL,
    UNIQUE (provider_id, instrument_id, event_id),
    UNIQUE (provider_id, instrument_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_market_data_events_order
    ON market_data_events (provider_id, instrument_id, sequence);

-- UPDATE immutability is enforced. DELETE is intentionally not blocked here:
-- D-008 retention is unresolved and future per-provider terms may require
-- controlled cleanup. No automatic cleanup or public delete endpoint exists.
CREATE TRIGGER IF NOT EXISTS trg_market_data_events_no_update
BEFORE UPDATE ON market_data_events
BEGIN
    SELECT RAISE(ABORT, 'market_data_events is update-immutable');
END;
"""

MIGRATION_COLUMNS = (
    ("provider_contributions", "TEXT NOT NULL DEFAULT '[]'"),
    ("excluded_provider_keys", "TEXT NOT NULL DEFAULT '[]'"),
    (
        "provider_metadata_status",
        "TEXT NOT NULL DEFAULT 'NOT_PROVIDED_OR_PEGGED'",
    ),
    ("raw_payload_sha256", "TEXT"),
    ("raw_payload_bytes", "INTEGER"),
    ("normalization_version", "TEXT"),
    ("schema_version", "TEXT"),
)

EVENT_MIGRATION_COLUMNS = (
    (
        "sequence_kind",
        f"TEXT NOT NULL DEFAULT '{LOCAL_REPLAY_SEQUENCE_KIND}' "
        f"CHECK (sequence_kind = '{LOCAL_REPLAY_SEQUENCE_KIND}')",
    ),
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _safe_text(value: Any, limit: int) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    if not text:
        return None
    return text[:limit]


class Store:
    def __init__(self, path: str | Path, *, read_only: bool = False) -> None:
        self.path = Path(path)
        if read_only:
            self.path = self.path.expanduser().resolve(strict=True)
            if not self.path.is_file():
                raise ValueError("read-only Store requires an existing database file")
            self.conn = sqlite3.connect(
                f"{self.path.as_uri()}?mode=ro",
                uri=True,
                check_same_thread=False,
            )
            self.conn.row_factory = sqlite3.Row
            self._lock = threading.RLock()
            return

        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self.conn.executescript(SCHEMA)
        self._migrate_schema()
        self._migrate_event_journal()
        self._backfill_provider_metadata()
        self.conn.commit()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self.conn.close()

    def _migrate_schema(self) -> None:
        columns = {
            row["name"] for row in self.conn.execute("PRAGMA table_info(fx_rates)")
        }
        for name, definition in MIGRATION_COLUMNS:
            if name not in columns:
                self.conn.execute(
                    f"ALTER TABLE fx_rates ADD COLUMN {name} {definition}"
                )

    def _migrate_event_journal(self) -> None:
        columns = {
            row["name"]
            for row in self.conn.execute("PRAGMA table_info(market_data_events)")
        }
        for name, definition in EVENT_MIGRATION_COLUMNS:
            if name not in columns:
                self.conn.execute(
                    f"ALTER TABLE market_data_events ADD COLUMN {name} {definition}"
                )
        # Retention remains unresolved under D-008, so only UPDATE immutability
        # is enforced. No automatic cleanup or public delete path is added.
        self.conn.execute("DROP TRIGGER IF EXISTS trg_market_data_events_no_delete")

    def _backfill_provider_metadata(self) -> None:
        """Recover contribution objects from raw_json for pre-migration rows."""
        rows = self.conn.execute(
            """SELECT rowid AS rid, raw_json FROM fx_rates
               WHERE provider_metadata_status=?
                 AND provider_contributions='[]'""",
            (PROVIDER_METADATA_NOT_PROVIDED,),
        ).fetchall()
        for row in rows:
            try:
                raw = json.loads(row["raw_json"])
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(raw, dict):
                continue
            try:
                contributions, status = parse_provider_contributions(raw)
            except NormalizationError:
                continue
            if status != PROVIDER_METADATA_PROVIDED:
                continue
            included = tuple(
                sorted({item.key for item in contributions if not item.excluded})
            )
            excluded = tuple(
                sorted({item.key for item in contributions if item.excluded})
            )
            self.conn.execute(
                """UPDATE fx_rates
                   SET provider_keys=?,
                       excluded_provider_keys=?,
                       provider_contributions=?,
                       provider_metadata_status=?
                   WHERE rowid=?""",
                (
                    json.dumps(list(included)),
                    json.dumps(list(excluded)),
                    json.dumps([item.as_dict() for item in contributions]),
                    status,
                    row["rid"],
                ),
            )

    def upsert(self, observations: Iterable[Observation]) -> dict[str, int]:
        """Insert or update by (provider, base, quote, observation_date)."""
        with self._lock:
            inserted = 0
            updated = 0
            now = _utc_now()
            for obs in observations:
                exists = self.conn.execute(
                    """SELECT 1 FROM fx_rates
                       WHERE provider_id=? AND base=? AND quote=? AND observation_date=?""",
                    (obs.provider_id, obs.base, obs.quote, obs.observation_date),
                ).fetchone()
                self.conn.execute(
                    """INSERT INTO fx_rates (
                           provider_id, base, quote, observation_date, rate,
                           data_status, price_type, executable, source_name,
                           attribution, provider_keys, excluded_provider_keys,
                           provider_contributions, provider_metadata_status,
                           received_at, endpoint, raw_json,
                           raw_payload_sha256, raw_payload_bytes,
                           normalization_version, schema_version,
                           created_at, updated_at
                       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(provider_id, base, quote, observation_date)
                       DO UPDATE SET
                           rate=excluded.rate,
                           data_status=excluded.data_status,
                           price_type=excluded.price_type,
                           executable=excluded.executable,
                           source_name=excluded.source_name,
                           attribution=excluded.attribution,
                           provider_keys=excluded.provider_keys,
                           excluded_provider_keys=excluded.excluded_provider_keys,
                           provider_contributions=excluded.provider_contributions,
                           provider_metadata_status=excluded.provider_metadata_status,
                           received_at=excluded.received_at,
                           endpoint=excluded.endpoint,
                           raw_json=excluded.raw_json,
                           raw_payload_sha256=excluded.raw_payload_sha256,
                           raw_payload_bytes=excluded.raw_payload_bytes,
                           normalization_version=excluded.normalization_version,
                           schema_version=excluded.schema_version,
                           updated_at=excluded.updated_at
                    """,
                    (
                        obs.provider_id,
                        obs.base,
                        obs.quote,
                        obs.observation_date,
                        str(obs.rate),
                        obs.data_status,
                        obs.price_type,
                        1 if obs.executable else 0,
                        obs.source_name,
                        obs.attribution,
                        json.dumps(list(obs.provider_keys)),
                        json.dumps(list(obs.excluded_provider_keys)),
                        json.dumps(
                            [item.as_dict() for item in obs.provider_contributions]
                        ),
                        obs.provider_metadata_status,
                        obs.received_at,
                        obs.endpoint,
                        obs.raw_json,
                        obs.raw_payload_sha256,
                        obs.raw_payload_bytes,
                        obs.normalization_version,
                        obs.schema_version,
                        now,
                        now,
                    ),
                )
                if exists:
                    updated += 1
                else:
                    inserted += 1
            self.conn.commit()
            return {"inserted": inserted, "updated": updated, "total": inserted + updated}

    def count(self) -> int:
        with self._lock:
            row = self.conn.execute("SELECT COUNT(*) AS n FROM fx_rates").fetchone()
            return int(row["n"])

    def list_rates(self, limit: int | None = 100) -> list[dict[str, Any]]:
        select = """SELECT provider_id, base, quote, observation_date, rate,
                           data_status, price_type, executable, source_name,
                           attribution, provider_keys, excluded_provider_keys,
                           provider_contributions, provider_metadata_status,
                           received_at, endpoint,
                           raw_payload_sha256, raw_payload_bytes,
                           normalization_version, schema_version,
                           created_at, updated_at
                    FROM fx_rates
                    ORDER BY observation_date DESC, base ASC, quote ASC"""
        with self._lock:
            if limit is None:
                rows = self.conn.execute(select).fetchall()
            else:
                safe_limit = max(1, min(int(limit), 1000))
                rows = self.conn.execute(
                    select + " LIMIT ?", (safe_limit,)
                ).fetchall()

        result: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["executable"] = bool(item["executable"])
            for field in (
                "provider_keys",
                "excluded_provider_keys",
                "provider_contributions",
            ):
                try:
                    item[field] = json.loads(item[field])
                except (json.JSONDecodeError, TypeError):
                    item[field] = []
            result.append(item)
        return result

    def append_events(
        self, events: Iterable[MarketDataEvent]
    ) -> dict[str, int]:
        """Append replay events idempotently; conflicting identity is rejected.

        Out-of-order arrivals are retained. Reads are ordered by the local
        replay sequence per instrument, not by insertion time. The batch is
        atomic: any conflicting event rolls back every insert in this call.
        """
        inserted = 0
        duplicates = 0
        comparable_fields = (
            "instrument_id",
            "sequence",
            "sequence_kind",
            "event_timestamp",
            "payload_json",
            "source_payload_sha256",
            "source_payload_bytes",
            "is_replay",
        )

        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                for event in events:
                    if not isinstance(event, MarketDataEvent):
                        raise TypeError("events must contain MarketDataEvent values")

                    existing = self.conn.execute(
                        """SELECT instrument_id, sequence, sequence_kind,
                                  event_timestamp, received_timestamp, payload_json,
                                  source_payload_sha256, source_payload_bytes,
                                  is_replay
                           FROM market_data_events
                           WHERE provider_id=? AND instrument_id=? AND event_id=?""",
                        (event.provider_id, event.instrument_id, event.event_id),
                    ).fetchone()

                    incoming = (
                        event.instrument_id,
                        event.sequence,
                        event.sequence_kind,
                        event.event_timestamp,
                        event.payload_json,
                        event.source_payload_sha256,
                        event.source_payload_bytes,
                        1,
                    )

                    if existing is not None:
                        stored = tuple(existing[field] for field in comparable_fields)
                        if stored != incoming:
                            raise MarketDataEventConflict(
                                "event_id was already used for different content: "
                                f"{event.provider_id}/{event.instrument_id}/"
                                f"{event.event_id}"
                            )
                        duplicates += 1
                        continue

                    sequence_owner = self.conn.execute(
                        """SELECT event_id FROM market_data_events
                           WHERE provider_id=? AND instrument_id=? AND sequence=?""",
                        (event.provider_id, event.instrument_id, event.sequence),
                    ).fetchone()
                    if sequence_owner is not None:
                        raise MarketDataEventConflict(
                            "local replay sequence was already used by another "
                            f"event: {event.provider_id}/{event.instrument_id}/"
                            f"{event.sequence}"
                        )

                    self.conn.execute(
                        """INSERT INTO market_data_events (
                               provider_id, event_id, instrument_id, sequence,
                               sequence_kind, event_timestamp, received_timestamp,
                               payload_json, source_payload_sha256,
                               source_payload_bytes, is_replay, stored_at
                           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            event.provider_id,
                            event.event_id,
                            event.instrument_id,
                            event.sequence,
                            event.sequence_kind,
                            event.event_timestamp,
                            event.received_timestamp,
                            event.payload_json,
                            event.source_payload_sha256,
                            event.source_payload_bytes,
                            1,
                            _utc_now(),
                        ),
                    )
                    inserted += 1

                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

        return {
            "inserted": inserted,
            "duplicates": duplicates,
            "total": inserted + duplicates,
        }

    def count_events(self) -> int:
        with self._lock:
            row = self.conn.execute(
                "SELECT COUNT(*) AS n FROM market_data_events"
            ).fetchone()
        return int(row["n"])

    def audit_events(
        self, *, max_errors: int = DEFAULT_MAX_ERRORS
    ) -> dict[str, Any]:
        """Read-only integrity audit of stored replay events.

        Rows are streamed from a read-only cursor without writes, repairs,
        migrations, or deletion. The result contains counts plus bounded row
        identifiers and error codes; it never returns rate values or raw payload
        text.
        """
        with self._lock:
            rows = self.conn.execute(
                """SELECT event_row_id, provider_id, event_id, instrument_id,
                          sequence, sequence_kind, event_timestamp,
                          received_timestamp, payload_json,
                          source_payload_sha256, source_payload_bytes,
                          is_replay, stored_at
                   FROM market_data_events
                   ORDER BY event_row_id ASC"""
            )
            return audit_event_rows(rows, max_errors=max_errors)

    def list_events(
        self,
        *,
        provider_id: str | None = None,
        instrument_id: str | None = None,
        after_sequence: int | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """List replay events by local replay sequence, preserving arrival order."""
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
            raise ValueError("limit must be a positive integer")
        if (provider_id is None) != (instrument_id is None):
            raise ValueError(
                "provider_id and instrument_id must be supplied together"
            )
        if after_sequence is not None and (
            isinstance(after_sequence, bool)
            or not isinstance(after_sequence, int)
            or after_sequence < 0
        ):
            raise ValueError("after_sequence must be a non-negative integer")
        if after_sequence is not None and (
            provider_id is None or instrument_id is None
        ):
            raise ValueError(
                "after_sequence requires both provider_id and instrument_id"
            )

        clauses: list[str] = []
        params: list[Any] = []
        for field, value in (
            ("provider_id", provider_id),
            ("instrument_id", instrument_id),
        ):
            if value is not None:
                if not isinstance(value, str) or not value.strip():
                    raise ValueError(f"{field} must be a non-empty string")
                clauses.append(f"{field}=?")
                params.append(value.strip())
        if after_sequence is not None:
            clauses.append("sequence>?")
            params.append(after_sequence)

        query = """SELECT provider_id, event_id, instrument_id, sequence,
                          sequence_kind, event_timestamp, received_timestamp,
                          payload_json, source_payload_sha256, source_payload_bytes,
                          is_replay, stored_at
                   FROM market_data_events"""
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY provider_id ASC, instrument_id ASC, sequence ASC LIMIT ?"
        params.append(min(limit, 1000))

        with self._lock:
            rows = self.conn.execute(query, params).fetchall()
        result = [dict(row) for row in rows]
        for item in result:
            item["is_replay"] = bool(item["is_replay"])
        return result

    def record_attempt(
        self,
        *,
        provider_id: str,
        endpoint: str,
        attempted_at: str,
        completed_at: str,
        duration_ms: int,
        http_status: int | None,
        outcome: str,
        rows_fetched: int = 0,
        error_class: str | None = None,
        error_message: str | None = None,
    ) -> int:
        """Record one explicit fetch attempt. No polling or scheduling."""
        if outcome not in ("OK", "ERROR"):
            raise ValueError("outcome must be OK or ERROR")
        with self._lock:
            cursor = self.conn.execute(
                """INSERT INTO provider_fetch_attempts (
                       provider_id, endpoint, attempted_at, completed_at,
                       duration_ms, http_status, outcome, rows_fetched,
                       error_class, error_message
                   ) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    provider_id,
                    _safe_text(endpoint, 500) or "",
                    attempted_at,
                    completed_at,
                    max(0, int(duration_ms)),
                    http_status,
                    outcome,
                    max(0, int(rows_fetched)),
                    _safe_text(error_class, 120),
                    _safe_text(error_message, 300),
                ),
            )
            self.conn.commit()
            return int(cursor.lastrowid)

    def provider_health(
        self, provider_id: str = "frankfurter-blended"
    ) -> dict[str, Any]:
        """Latest recorded attempt and trailing consecutive failures."""
        with self._lock:
            latest = self.conn.execute(
                """SELECT id, provider_id, endpoint, attempted_at, completed_at,
                          duration_ms, http_status, outcome, rows_fetched,
                          error_class, error_message
                   FROM provider_fetch_attempts
                   WHERE provider_id=?
                   ORDER BY id DESC LIMIT 1""",
                (provider_id,),
            ).fetchone()
            outcomes = self.conn.execute(
                """SELECT outcome FROM provider_fetch_attempts
                   WHERE provider_id=?
                   ORDER BY id DESC LIMIT 1000""",
                (provider_id,),
            ).fetchall()
            attempts = self.conn.execute(
                """SELECT COUNT(*) AS n FROM provider_fetch_attempts
                   WHERE provider_id=?""",
                (provider_id,),
            ).fetchone()
            last_success = self.conn.execute(
                """SELECT completed_at FROM provider_fetch_attempts
                   WHERE provider_id=? AND outcome='OK'
                   ORDER BY id DESC LIMIT 1""",
                (provider_id,),
            ).fetchone()

        consecutive_failures = 0
        for row in outcomes:
            if row["outcome"] == "ERROR":
                consecutive_failures += 1
            else:
                break

        latest_attempt = dict(latest) if latest is not None else None
        if latest_attempt is None:
            status = "NO_ATTEMPTS"
        else:
            status = "OK" if latest_attempt["outcome"] == "OK" else "ERROR"

        return {
            "provider_id": provider_id,
            "status": status,
            "latest_attempt": latest_attempt,
            "consecutive_failures": consecutive_failures,
            "attempts_recorded": int(attempts["n"]),
            "last_success_at": (
                last_success["completed_at"] if last_success is not None else None
            ),
            "internet_status_asserted": False,
            "note": (
                "Based only on recorded one-shot fetch attempts; "
                "no background polling or internet-status claim."
            ),
        }

    def health(self) -> dict[str, Any]:
        with self._lock:
            row = self.conn.execute(
                "SELECT COUNT(*) AS n, MAX(received_at) AS last_received_at FROM fx_rates"
            ).fetchone()
        return {
            "status": "ok",
            "database": str(self.path),
            "stored_observations": int(row["n"]),
            "last_received_at": row["last_received_at"],
            "provider": "frankfurter-blended",
            "data_status": "DAILY_REFERENCE",
        }
