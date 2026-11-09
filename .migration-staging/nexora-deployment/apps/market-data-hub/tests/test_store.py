import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexora_market_data import (  # noqa: E402
    NORMALIZATION_VERSION,
    OBSERVATION_SCHEMA_VERSION,
)
from nexora_market_data.events import MarketDataEvent  # noqa: E402
from nexora_market_data.normalizer import normalize_payload  # noqa: E402
from nexora_market_data.store import Store  # noqa: E402

RECEIVED = "2026-11-01T00:00:00+00:00"
ENDPOINT = "https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR&expand=providers"
RAW_SHA256 = "b" * 64


def payload(rate="0.89485"):
    return [
        {
            "date": "2026-10-31",
            "base": "USD",
            "quote": "EUR",
            "rate": Decimal(rate),
            "providers": [{"key": "ECB", "date": "2026-10-30", "rate": Decimal("0.89509")}],
        }
    ]


class StoreTests(unittest.TestCase):
    def test_upsert_deduplicates_and_updates(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "test.db"
            with Store(db) as store:
                observations = normalize_payload(payload(), RECEIVED, ENDPOINT)
                first = store.upsert(observations)
                self.assertEqual(first, {"inserted": 1, "updated": 0, "total": 1})
                self.assertEqual(store.count(), 1)

                second = store.upsert(observations)
                self.assertEqual(second, {"inserted": 0, "updated": 1, "total": 1})
                self.assertEqual(store.count(), 1)

                rows = store.list_rates()
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["rate"], "0.89485")
                self.assertEqual(rows[0]["provider_keys"], ["ECB"])
                self.assertEqual(rows[0]["excluded_provider_keys"], [])
                self.assertEqual(rows[0]["provider_metadata_status"], "PROVIDED")
                self.assertEqual(
                    rows[0]["provider_contributions"],
                    [
                        {
                            "key": "ECB",
                            "date": "2026-10-30",
                            "rate": "0.89509",
                            "excluded": False,
                        }
                    ],
                )
                self.assertFalse(rows[0]["executable"])
                self.assertIn("ECB", rows[0]["attribution"])
                self.assertEqual(rows[0]["data_status"], "DAILY_REFERENCE")

            with Store(db) as store:
                updated = store.upsert(
                    normalize_payload(payload("0.90001"), RECEIVED, ENDPOINT)
                )
                self.assertEqual(updated, {"inserted": 0, "updated": 1, "total": 1})
                self.assertEqual(store.count(), 1)
                self.assertEqual(store.list_rates()[0]["rate"], "0.90001")
                self.assertEqual(store.health()["stored_observations"], 1)

    def test_persists_provenance_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "provenance.db"
            observations = normalize_payload(
                payload(),
                RECEIVED,
                ENDPOINT,
                raw_payload_sha256=RAW_SHA256,
                raw_payload_bytes=456,
            )
            with Store(db) as store:
                store.upsert(observations)
                row = store.list_rates()[0]
                self.assertEqual(row["raw_payload_sha256"], RAW_SHA256)
                self.assertEqual(row["raw_payload_bytes"], 456)
                self.assertEqual(row["normalization_version"], NORMALIZATION_VERSION)
                self.assertEqual(row["schema_version"], OBSERVATION_SCHEMA_VERSION)

            with Store(db) as store:
                row = store.list_rates()[0]
                self.assertEqual(row["raw_payload_sha256"], RAW_SHA256)
                self.assertEqual(row["raw_payload_bytes"], 456)

    def test_provider_attempts_and_consecutive_failures(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "attempts.db"
            with Store(db) as store:
                store.record_attempt(
                    provider_id="frankfurter-blended",
                    endpoint="https://example.test/v2/rates",
                    attempted_at="2026-11-01T00:00:00+00:00",
                    completed_at="2026-11-01T00:00:01+00:00",
                    duration_ms=1000,
                    http_status=200,
                    outcome="OK",
                    rows_fetched=4,
                )
                store.record_attempt(
                    provider_id="frankfurter-blended",
                    endpoint="https://example.test/v2/rates",
                    attempted_at="2026-11-01T00:01:00+00:00",
                    completed_at="2026-11-01T00:01:01+00:00",
                    duration_ms=1000,
                    http_status=503,
                    outcome="ERROR",
                    error_class="ProviderError",
                    error_message="line one\nline two",
                )
                store.record_attempt(
                    provider_id="frankfurter-blended",
                    endpoint="https://example.test/v2/rates",
                    attempted_at="2026-11-01T00:02:00+00:00",
                    completed_at="2026-11-01T00:02:01+00:00",
                    duration_ms=1000,
                    http_status=None,
                    outcome="ERROR",
                    error_class="ProviderError",
                    error_message="x" * 400,
                )

                health = store.provider_health()
                self.assertEqual(health["attempts_recorded"], 3)
                self.assertEqual(health["consecutive_failures"], 2)
                self.assertEqual(health["status"], "ERROR")
                self.assertEqual(health["latest_attempt"]["outcome"], "ERROR")
                self.assertLessEqual(len(health["latest_attempt"]["error_message"]), 300)
                self.assertEqual(health["last_success_at"], "2026-11-01T00:00:01+00:00")
                self.assertFalse(health["internet_status_asserted"])

            with Store(db) as store:
                store.record_attempt(
                    provider_id="frankfurter-blended",
                    endpoint="https://example.test/v2/rates",
                    attempted_at="2026-11-01T00:03:00+00:00",
                    completed_at="2026-11-01T00:03:01+00:00",
                    duration_ms=1000,
                    http_status=200,
                    outcome="OK",
                    rows_fetched=4,
                )
                health = store.provider_health()
                self.assertEqual(health["consecutive_failures"], 0)
                self.assertEqual(health["status"], "OK")

    def test_migrates_old_fx_table_and_backfills_contributions(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "old.db"
            conn = sqlite3.connect(db)
            conn.executescript(
                """
                CREATE TABLE fx_rates (
                    provider_id TEXT NOT NULL,
                    base TEXT NOT NULL,
                    quote TEXT NOT NULL,
                    observation_date TEXT NOT NULL,
                    rate TEXT NOT NULL,
                    data_status TEXT NOT NULL,
                    price_type TEXT NOT NULL,
                    executable INTEGER NOT NULL,
                    source_name TEXT NOT NULL,
                    attribution TEXT NOT NULL,
                    provider_keys TEXT NOT NULL,
                    received_at TEXT NOT NULL,
                    endpoint TEXT NOT NULL,
                    raw_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (provider_id, base, quote, observation_date)
                );
                """
            )
            raw = {
                "date": "2026-10-31",
                "base": "USD",
                "quote": "EUR",
                "rate": "0.89485",
                "providers": [
                    {"key": "ECB", "date": "2026-10-30", "rate": "0.89509"},
                    {
                        "key": "BAD",
                        "date": "2026-10-30",
                        "rate": "9.9",
                        "excluded": True,
                    },
                ],
            }
            conn.execute(
                """INSERT INTO fx_rates VALUES
                   (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    "frankfurter-blended",
                    "USD",
                    "EUR",
                    "2026-10-31",
                    "0.89485",
                    "DAILY_REFERENCE",
                    "MID",
                    0,
                    "Frankfurter v2 (blended daily reference)",
                    "Frankfurter blended daily reference rates; contributors: ECB",
                    json.dumps(["ECB"]),
                    "2026-11-01T00:00:00+00:00",
                    "https://example.test/v2/rates",
                    json.dumps(raw),
                    "2026-11-01T00:00:00+00:00",
                    "2026-11-01T00:00:00+00:00",
                ),
            )
            conn.commit()
            conn.close()

            with Store(db) as store:
                columns = {
                    row["name"]
                    for row in store.conn.execute("PRAGMA table_info(fx_rates)")
                }
                for field in (
                    "raw_payload_sha256",
                    "raw_payload_bytes",
                    "normalization_version",
                    "schema_version",
                ):
                    self.assertIn(field, columns)
                rows = store.list_rates()
                self.assertEqual(rows[0]["provider_metadata_status"], "PROVIDED")
                self.assertEqual(rows[0]["provider_keys"], ["ECB"])
                self.assertEqual(rows[0]["excluded_provider_keys"], ["BAD"])
                self.assertEqual(rows[0]["provider_contributions"][0]["key"], "ECB")
                self.assertIsNone(rows[0]["raw_payload_sha256"])
                self.assertIsNone(rows[0]["raw_payload_bytes"])
                self.assertIsNone(rows[0]["normalization_version"])
                self.assertIsNone(rows[0]["schema_version"])


    def test_read_only_mode_does_not_migrate_or_change_legacy_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "legacy-ro.db"
            conn = sqlite3.connect(db)
            conn.executescript(
                """
                CREATE TABLE fx_rates (
                    provider_id TEXT NOT NULL,
                    base TEXT NOT NULL,
                    quote TEXT NOT NULL,
                    observation_date TEXT NOT NULL,
                    rate TEXT NOT NULL,
                    data_status TEXT NOT NULL,
                    price_type TEXT NOT NULL,
                    executable INTEGER NOT NULL,
                    source_name TEXT NOT NULL,
                    attribution TEXT NOT NULL,
                    provider_keys TEXT NOT NULL,
                    received_at TEXT NOT NULL,
                    endpoint TEXT NOT NULL,
                    raw_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (provider_id, base, quote, observation_date)
                );
                CREATE TABLE market_data_events (
                    event_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider_id TEXT NOT NULL,
                    event_id TEXT NOT NULL,
                    instrument_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    event_timestamp TEXT NOT NULL,
                    received_timestamp TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    source_payload_sha256 TEXT NOT NULL,
                    source_payload_bytes INTEGER NOT NULL,
                    is_replay INTEGER NOT NULL,
                    stored_at TEXT NOT NULL
                );
                INSERT INTO market_data_events VALUES
                    (1, 'replay-local', 'legacy-event', 'USD/EUR', 0,
                     '2026-10-30T00:00:00Z', '1970-01-01T00:00:00Z',
                     '{"rate":"0.9"}', '0000000000000000000000000000000000000000000000000000000000000000',
                     12, 1, '2026-11-01T00:00:00Z');
                """
            )
            conn.commit()
            conn.close()

            digest_before = hashlib.sha256(db.read_bytes()).hexdigest()
            objects_before = self._sqlite_objects(db)

            with Store(db, read_only=True) as store:
                fx_columns = {
                    row["name"]
                    for row in store.conn.execute("PRAGMA table_info(fx_rates)")
                }
                event_columns = {
                    row["name"]
                    for row in store.conn.execute(
                        "PRAGMA table_info(market_data_events)"
                    )
                }
                with self.assertRaises(sqlite3.OperationalError):
                    store.audit_events()

            self.assertEqual(
                hashlib.sha256(db.read_bytes()).hexdigest(), digest_before
            )
            self.assertEqual(self._sqlite_objects(db), objects_before)
            for field in (
                "provider_contributions",
                "excluded_provider_keys",
                "provider_metadata_status",
                "raw_payload_sha256",
                "raw_payload_bytes",
                "normalization_version",
                "schema_version",
            ):
                self.assertNotIn(field, fx_columns)
            self.assertNotIn("sequence_kind", event_columns)

    def test_read_only_store_denies_all_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "readonly-writes.db"
            with Store(db):
                pass

            event = MarketDataEvent(
                provider_id="replay-local",
                instrument_id="USD/EUR",
                event_id="replay-denied",
                sequence=0,
                event_timestamp="2026-10-30T00:00:00+00:00",
                received_timestamp="1970-01-01T00:00:00+00:00",
                payload_json=json.dumps({"rate": "0.9"}),
                source_payload_sha256="a" * 64,
                source_payload_bytes=12,
            )
            observations = normalize_payload(payload(), RECEIVED, ENDPOINT)

            with Store(db, read_only=True) as store:
                writes = (
                    lambda: store.upsert(observations),
                    lambda: store.append_events([event]),
                    lambda: store.record_attempt(
                        provider_id="replay-local",
                        endpoint="replay://local-fixtures",
                        attempted_at=RECEIVED,
                        completed_at=RECEIVED,
                        duration_ms=1,
                        http_status=200,
                        outcome="OK",
                    ),
                )
                for write in writes:
                    with self.assertRaises(sqlite3.OperationalError):
                        write()

    def test_read_only_store_requires_existing_file_without_creating_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "nested" / "missing.db"
            with self.assertRaises(FileNotFoundError):
                Store(target, read_only=True)
            self.assertFalse(target.exists())
            self.assertFalse(target.parent.exists())

    @staticmethod
    def _sqlite_objects(db: Path) -> list[tuple[str, str]]:
        conn = sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True)
        try:
            rows = conn.execute(
                "SELECT type, name FROM sqlite_master ORDER BY type, name"
            ).fetchall()
        finally:
            conn.close()
        return [(row[0], row[1]) for row in rows]


if __name__ == "__main__":
    unittest.main()
