import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexora_market_data.event_quality import audit_event_rows  # noqa: E402
from nexora_market_data.ingestion import (  # noqa: E402
    REPLAY_ENDPOINT,
    REPLAY_PROVIDER_ID,
    REPLAY_RECEIVED_AT,
    ReplaySource,
)
from nexora_market_data.replay_journal import journal_replay  # noqa: E402
from nexora_market_data.store import Store  # noqa: E402

FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "replay"

EVENT_TABLE_WITHOUT_TRIGGERS = """
CREATE TABLE market_data_events (
    event_row_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id           TEXT,
    event_id              TEXT,
    instrument_id         TEXT,
    sequence              INTEGER,
    sequence_kind         TEXT,
    event_timestamp       TEXT,
    received_timestamp    TEXT,
    payload_json          TEXT,
    source_payload_sha256 TEXT,
    source_payload_bytes  INTEGER,
    is_replay             INTEGER,
    stored_at             TEXT
);
"""

EVENT_COLUMNS = (
    "provider_id",
    "event_id",
    "instrument_id",
    "sequence",
    "sequence_kind",
    "event_timestamp",
    "received_timestamp",
    "payload_json",
    "source_payload_sha256",
    "source_payload_bytes",
    "is_replay",
    "stored_at",
)


def _source(fixtures=("batch-001.json", "batch-002.json")):
    return ReplaySource(
        FIXTURE_ROOT,
        list(fixtures),
        provider_id=REPLAY_PROVIDER_ID,
        endpoint=REPLAY_ENDPOINT,
        received_at=REPLAY_RECEIVED_AT,
    )


def _tampered(base, index, *, mutate_payload=None, **row_changes):
    row = dict(base)
    row["event_id"] = f"tampered-{index}"
    row["sequence"] = int(base["sequence"]) + index
    if mutate_payload is not None:
        payload = json.loads(row["payload_json"])
        mutate_payload(payload)
        row["payload_json"] = json.dumps(
            payload, sort_keys=True, separators=(",", ":")
        )
    row.update(row_changes)
    return row


class EventQualityTests(unittest.TestCase):
    def test_audits_valid_synthetic_replay_without_mutation_or_leakage(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "events.db") as store:
                journal_replay(_source(), store)
                before = [
                    tuple(row)
                    for row in store.conn.execute(
                        "SELECT * FROM market_data_events ORDER BY event_row_id"
                    )
                ]
                result = store.audit_events()
                after = [
                    tuple(row)
                    for row in store.conn.execute(
                        "SELECT * FROM market_data_events ORDER BY event_row_id"
                    )
                ]

                self.assertEqual(result["scanned"], 3)
                self.assertEqual(result["valid"], 3)
                self.assertEqual(result["invalid"], 0)
                self.assertEqual(result["errors"], [])
                self.assertFalse(result["errors_truncated"])
                self.assertEqual(before, after)
                self.assertEqual(store.count_events(), 3)

                rendered = json.dumps(result)
                self.assertNotIn("0.9001", rendered)
                self.assertNotIn("payload_json", rendered)
                self.assertNotIn('"rate"', rendered)

    def test_empty_journal_audits_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "events.db") as store:
                result = store.audit_events()
                self.assertEqual(
                    result,
                    {
                        "scanned": 0,
                        "valid": 0,
                        "invalid": 0,
                        "errors": [],
                        "errors_truncated": False,
                        "max_errors": 100,
                    },
                )

    def test_rejects_invalid_max_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "events.db") as store:
                for value in (0, True, 1.5, "2", 1001):
                    with self.subTest(value=value):
                        with self.assertRaises(ValueError):
                            store.audit_events(max_errors=value)
                self.assertEqual(
                    store.audit_events(max_errors=1000)["max_errors"], 1000
                )
                result = audit_event_rows(
                    [{"event_row_id": "untrusted", "payload_json": "{bad"}]
                )
                self.assertIsNone(result["errors"][0]["event_row_id"])
                self.assertNotIn("untrusted", json.dumps(result))

    def test_detects_tampered_rows_without_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_db = Path(tmp) / "source.db"
            with Store(source_db) as store:
                journal_replay(_source(("batch-001.json",)), store)
                base = store.list_events()[0]

            rows = [dict(base)]
            rows.append(
                _tampered(
                    base,
                    1,
                    mutate_payload=lambda payload: payload.update(
                        provider_id="other-replay"
                    ),
                )
            )
            rows.append(
                _tampered(
                    base,
                    2,
                    mutate_payload=lambda payload: payload.update(
                        instrument_id="FX:USD/JPY"
                    ),
                )
            )
            rows.append(
                _tampered(
                    base,
                    3,
                    source_payload_sha256="c" * 64,
                )
            )
            rows.append(
                _tampered(
                    base,
                    4,
                    sequence=int(base["sequence"]) + 1000,
                )
            )
            rows.append(
                _tampered(
                    base,
                    5,
                    event_timestamp="2026-10-30T12:00:00.000000Z",
                )
            )
            rows.append(
                _tampered(
                    base,
                    6,
                    mutate_payload=lambda payload: payload.update(rate="NaN"),
                )
            )
            rows.append(
                _tampered(
                    base,
                    7,
                    mutate_payload=lambda payload: payload.update(rate="0"),
                )
            )
            rows.append(
                _tampered(
                    base,
                    8,
                    mutate_payload=lambda payload: payload.update(rate=0.9),
                )
            )
            rows.append(_tampered(base, 9, payload_json="{not-json"))
            rows.append(_tampered(base, 10, is_replay=0))
            rows.append(_tampered(base, 11, sequence_kind="PROVIDER_ISSUED"))
            rows.append(
                _tampered(
                    base,
                    12,
                    mutate_payload=lambda payload: payload.update(
                        event_time_kind="OBSERVED_CLOCK_TIME"
                    ),
                )
            )
            rows.append(
                _tampered(
                    base,
                    13,
                    mutate_payload=lambda payload: payload.update(
                        received_time_kind="WALL_CLOCK_RECEIPT"
                    ),
                )
            )
            rows.append(_tampered(base, 14, event_id="not-canonical"))
            rows.append(
                _tampered(
                    base,
                    15,
                    source_payload_bytes=int(base["source_payload_bytes"]) + 1,
                )
            )
            rows.append(_tampered(base, 16, received_timestamp="not-a-timestamp"))
            rows.append(
                _tampered(
                    base,
                    17,
                    provider_id=None,
                    mutate_payload=lambda payload: payload.update(
                        provider_id=None
                    ),
                )
            )
            rows.append(
                _tampered(
                    base,
                    18,
                    event_id="SENSITIVE-MARKER-DO-NOT-ECHO",
                )
            )
            rows.append(
                _tampered(
                    base,
                    19,
                    received_timestamp="1970-01-01T00:00:01.000000Z",
                )
            )
            rows.append(
                _tampered(
                    base,
                    20,
                    mutate_payload=lambda payload: payload.update(
                        received_timestamp="1970-01-01T00:00:02.000000Z"
                    ),
                )
            )
            rows.append(
                _tampered(
                    base,
                    21,
                    mutate_payload=lambda payload: payload.update(
                        received_timestamp="not-a-timestamp"
                    ),
                )
            )

            db = Path(tmp) / "tampered.db"
            with sqlite3.connect(db) as conn:
                conn.executescript(EVENT_TABLE_WITHOUT_TRIGGERS)
                placeholders = ",".join("?" for _ in EVENT_COLUMNS)
                conn.executemany(
                    f"INSERT INTO market_data_events ({','.join(EVENT_COLUMNS)}) "
                    f"VALUES ({placeholders})",
                    [tuple(row[column] for column in EVENT_COLUMNS) for row in rows],
                )
                conn.commit()
                before = [
                    tuple(row)
                    for row in conn.execute(
                        "SELECT * FROM market_data_events ORDER BY event_row_id"
                    )
                ]
            conn.close()

            with Store(db) as store:
                result = store.audit_events()
                self.assertEqual(result["scanned"], len(rows))
                self.assertEqual(result["valid"], 1)
                self.assertEqual(result["invalid"], len(rows) - 1)
                self.assertFalse(result["errors_truncated"])
                self.assertEqual(len(result["errors"]), len(rows) - 1)

                codes = {
                    code
                    for entry in result["errors"]
                    for code in entry["errors"]
                }
                for expected in (
                    "PROVIDER_ID_MISMATCH",
                    "INSTRUMENT_ID_MISMATCH",
                    "SOURCE_HASH_MISMATCH",
                    "SEQUENCE_MISMATCH",
                    "EVENT_TIMESTAMP_MISMATCH",
                    "INVALID_RATE",
                    "INVALID_PAYLOAD_JSON",
                    "ROW_NOT_REPLAY",
                    "SEQUENCE_KIND_MISMATCH",
                    "EVENT_TIME_KIND_MISMATCH",
                    "RECEIVED_TIME_KIND_MISMATCH",
                    "EVENT_ID_MISMATCH",
                    "SOURCE_BYTES_MISMATCH",
                    "INVALID_RECEIVED_TIMESTAMP",
                    "RECEIVED_TIMESTAMP_MISMATCH",
                    "INVALID_PAYLOAD_RECEIVED_TIMESTAMP",
                    "INVALID_PROVIDER_ID",
                ):
                    with self.subTest(code=expected):
                        self.assertIn(expected, codes)

                for entry in result["errors"]:
                    self.assertEqual(set(entry), {"event_row_id", "errors"})
                    self.assertIsInstance(entry["event_row_id"], int)
                    self.assertGreaterEqual(entry["event_row_id"], 0)
                    self.assertIsInstance(entry["errors"], list)

                rendered = json.dumps(result)
                self.assertNotIn("0.9001", rendered)
                self.assertNotIn("NaN", rendered)
                self.assertNotIn("{not-json", rendered)
                self.assertNotIn("payload_json", rendered)
                self.assertNotIn('"rate"', rendered)
                self.assertNotIn("SENSITIVE-MARKER-DO-NOT-ECHO", rendered)
                self.assertNotIn('"event_id"', rendered)

                limited = store.audit_events(max_errors=3)
                self.assertEqual(limited["invalid"], len(rows) - 1)
                self.assertEqual(len(limited["errors"]), 3)
                self.assertTrue(limited["errors_truncated"])

                after = [
                    tuple(row)
                    for row in store.conn.execute(
                        "SELECT * FROM market_data_events ORDER BY event_row_id"
                    )
                ]
                self.assertEqual(before, after)
                self.assertEqual(store.count_events(), len(rows))


if __name__ == "__main__":
    unittest.main()
