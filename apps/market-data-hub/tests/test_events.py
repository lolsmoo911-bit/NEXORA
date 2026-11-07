import sqlite3
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexora_market_data.events import (  # noqa: E402
    LOCAL_REPLAY_SEQUENCE_KIND,
    MarketDataEvent,
    MarketDataEventConflict,
    MarketDataEventError,
)
from nexora_market_data.store import Store  # noqa: E402

RECEIVED = "2026-11-01T00:00:02Z"
HASH = "a" * 64


def event(
    sequence: int,
    *,
    event_id: str | None = None,
    provider_id: str = "synthetic-replay",
    instrument_id: str = "FX:USD/EUR",
    event_timestamp: str | None = None,
    received_timestamp: str = RECEIVED,
    payload_json: str | None = None,
    source_payload_sha256: str = HASH,
) -> MarketDataEvent:
    return MarketDataEvent(
        provider_id=provider_id,
        instrument_id=instrument_id,
        event_id=event_id or f"event-{sequence}",
        sequence=sequence,
        event_timestamp=event_timestamp or f"2026-11-01T00:00:0{sequence}Z",
        received_timestamp=received_timestamp,
        payload_json=payload_json or f'{{"value":"{sequence}.125","kind":"synthetic"}}',
        source_payload_sha256=source_payload_sha256,
        source_payload_bytes=128,
    )


class EventJournalTests(unittest.TestCase):
    def test_event_normalizes_timezone_and_preserves_decimal_json_text(self):
        item = event(
            1,
            event_timestamp="2026-11-01T01:00:01+01:00",
            received_timestamp="2026-11-01T01:00:02+01:00",
            payload_json='{"value":1.2300,"label":"synthetic"}',
        )
        self.assertEqual(item.event_timestamp, "2026-11-01T00:00:01.000000Z")
        self.assertEqual(item.received_timestamp, "2026-11-01T00:00:02.000000Z")
        self.assertEqual(item.payload_json, '{"value":1.2300,"label":"synthetic"}')
        self.assertTrue(item.is_replay)
        self.assertEqual(item.sequence_kind, LOCAL_REPLAY_SEQUENCE_KIND)

    def test_appends_out_of_order_events_and_reads_local_replay_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "events.db") as store:
                result = store.append_events([event(3), event(1), event(2)])
                self.assertEqual(result, {"inserted": 3, "duplicates": 0, "total": 3})
                self.assertEqual(store.count_events(), 3)
                self.assertEqual(store.count(), 0)

                rows = store.list_events(
                    provider_id="synthetic-replay",
                    instrument_id="FX:USD/EUR",
                )
                self.assertEqual([row["sequence"] for row in rows], [1, 2, 3])
                self.assertEqual(
                    [row["event_id"] for row in rows],
                    ["event-1", "event-2", "event-3"],
                )
                self.assertTrue(all(row["is_replay"] for row in rows))
                self.assertTrue(
                    all(
                        row["sequence_kind"] == LOCAL_REPLAY_SEQUENCE_KIND
                        for row in rows
                    )
                )

    def test_duplicate_event_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "events.db") as store:
                item = event(1)
                self.assertEqual(
                    store.append_events([item]),
                    {"inserted": 1, "duplicates": 0, "total": 1},
                )
                retry = replace(
                    item,
                    received_timestamp="2026-11-01T00:00:09Z",
                )
                self.assertEqual(
                    store.append_events([retry]),
                    {"inserted": 0, "duplicates": 1, "total": 1},
                )
                self.assertEqual(store.count_events(), 1)
                self.assertEqual(
                    store.list_events()[0]["received_timestamp"],
                    item.received_timestamp,
                )
                self.assertEqual(
                    store.list_events()[0]["source_payload_sha256"],
                    item.source_payload_sha256,
                )

    def test_changed_source_hash_for_same_event_identity_is_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "events.db") as store:
                item = event(1)
                store.append_events([item])
                changed_hash = replace(
                    item,
                    source_payload_sha256="b" * 64,
                    source_payload_bytes=256,
                )
                with self.assertRaises(MarketDataEventConflict):
                    store.append_events([changed_hash])
                self.assertEqual(store.count_events(), 1)

    def test_reused_event_id_with_different_content_is_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "events.db") as store:
                store.append_events([event(1)])
                changed = event(
                    1,
                    payload_json='{"value":"999","kind":"synthetic"}',
                )
                with self.assertRaises(MarketDataEventConflict):
                    store.append_events([changed])
                self.assertEqual(store.count_events(), 1)

    def test_reused_provider_instrument_sequence_is_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "events.db") as store:
                store.append_events([event(1)])
                changed_id = event(1, event_id="different-id")
                with self.assertRaises(MarketDataEventConflict):
                    store.append_events([changed_id])
                self.assertEqual(store.count_events(), 1)

    def test_conflict_rolls_back_entire_batch(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "events.db") as store:
                store.append_events([event(1)])
                valid_new = event(2)
                conflict = event(1, event_id="different-id")
                with self.assertRaises(MarketDataEventConflict):
                    store.append_events([valid_new, conflict])
                self.assertEqual(store.count_events(), 1)
                self.assertEqual(
                    [row["sequence"] for row in store.list_events()],
                    [1],
                )

    def test_sequence_scope_is_per_provider_and_instrument(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "events.db") as store:
                store.append_events(
                    [
                        event(1),
                        event(
                            1,
                            event_id="other-provider-1",
                            provider_id="other-synthetic",
                        ),
                        event(
                            1,
                            event_id="event-1",
                            instrument_id="FX:GBP/USD",
                        ),
                    ]
                )
                self.assertEqual(store.count_events(), 3)

    def test_list_events_supports_sequence_cursor_and_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "events.db") as store:
                store.append_events(
                    [
                        event(3),
                        event(1),
                        event(2),
                        event(1, event_id="gbp-1", instrument_id="FX:GBP/USD"),
                    ]
                )
                rows = store.list_events(
                    provider_id="synthetic-replay",
                    instrument_id="FX:USD/EUR",
                    after_sequence=1,
                    limit=1,
                )
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["sequence"], 2)
                # The cursor is scoped to the requested instrument only.
                other = store.list_events(
                    provider_id="synthetic-replay",
                    instrument_id="FX:GBP/USD",
                    after_sequence=0,
                )
                self.assertEqual([row["event_id"] for row in other], ["gbp-1"])
                with self.assertRaises(ValueError):
                    store.list_events(after_sequence=-1)
                with self.assertRaises(ValueError):
                    store.list_events(after_sequence=1)
                with self.assertRaises(ValueError):
                    store.list_events(provider_id="synthetic-replay")
                with self.assertRaises(ValueError):
                    store.list_events(instrument_id="FX:USD/EUR")
                for invalid_limit in (0, True, 1.5, "2"):
                    with self.subTest(invalid_limit=invalid_limit):
                        with self.assertRaises(ValueError):
                            store.list_events(limit=invalid_limit)

    def test_event_table_update_is_immutable_and_delete_is_not_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "events.db") as store:
                store.append_events([event(1)])
                with self.assertRaises(sqlite3.IntegrityError):
                    store.conn.execute(
                        "UPDATE market_data_events SET payload_json='{}'"
                    )
                # D-008 retention is unresolved. No public delete API or
                # automatic cleanup exists, but a future authorized retention
                # policy must be able to remove rows.
                store.conn.execute("DELETE FROM market_data_events")
                self.assertEqual(store.count_events(), 0)

    def test_migrates_legacy_event_journal_without_touching_fx_rates(self):
        legacy_event_schema = """
            CREATE TABLE market_data_events (
                event_row_id          INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_id           TEXT NOT NULL,
                event_id              TEXT NOT NULL,
                instrument_id         TEXT NOT NULL,
                sequence              INTEGER NOT NULL CHECK (sequence >= 0),
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
            CREATE TRIGGER trg_market_data_events_no_update
            BEFORE UPDATE ON market_data_events
            BEGIN
                SELECT RAISE(ABORT, 'market_data_events is append-only');
            END;
            CREATE TRIGGER trg_market_data_events_no_delete
            BEFORE DELETE ON market_data_events
            BEGIN
                SELECT RAISE(ABORT, 'market_data_events is append-only');
            END;
        """
        legacy_row = (
            "synthetic-replay",
            "legacy-event-1",
            "FX:USD/EUR",
            739000,
            "2026-10-30T00:00:00.000000Z",
            "1970-01-01T00:00:00.000000Z",
            '{"is_replay":true,"rate":"0.9001"}',
            "a" * 64,
            12,
            1,
            "2026-11-01T00:00:00Z",
        )
        fx_row = (
            "replay-local",
            "USD",
            "EUR",
            "2026-10-30",
            "0.9001",
            "DAILY_REFERENCE",
            "MID",
            0,
            "Synthetic replay",
            "Synthetic replay",
            '["SYNTH-A"]',
            "[]",
            '[{"key":"SYNTH-A","date":"2026-10-30","rate":"0.9004",'
            '"excluded":false}]',
            "PROVIDED",
            "1970-01-01T00:00:00Z",
            "replay://local-fixtures",
            '{"date":"2026-10-30","base":"USD","quote":"EUR",'
            '"rate":0.9001,"providers":[]}',
            "b" * 64,
            123,
            "nexora-normalizer/1",
            "nexora-fx-observation/1",
            "2026-11-01T00:00:00Z",
            "2026-11-01T00:00:00Z",
        )

        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "legacy-events.db"
            # Start from a current database so fx_rates has a real row, then
            # replace only the event journal with its previous schema.
            with Store(db):
                pass
            with sqlite3.connect(db) as conn:
                conn.execute(
                    """INSERT INTO fx_rates (
                           provider_id, base, quote, observation_date, rate,
                           data_status, price_type, executable, source_name,
                           attribution, provider_keys, excluded_provider_keys,
                           provider_contributions, provider_metadata_status,
                           received_at, endpoint, raw_json, raw_payload_sha256,
                           raw_payload_bytes, normalization_version, schema_version,
                           created_at, updated_at
                       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    fx_row,
                )
                conn.execute("DROP TABLE market_data_events")
                conn.executescript(legacy_event_schema)
                conn.execute(
                    """INSERT INTO market_data_events (
                           provider_id, event_id, instrument_id, sequence,
                           event_timestamp, received_timestamp, payload_json,
                           source_payload_sha256, source_payload_bytes,
                           is_replay, stored_at
                       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    legacy_row,
                )
                conn.commit()
                fx_schema_before = [
                    tuple(row)
                    for row in conn.execute("PRAGMA table_info(fx_rates)")
                ]
                fx_rows_before = [
                    tuple(row)
                    for row in conn.execute(
                        """SELECT * FROM fx_rates
                           ORDER BY provider_id, base, quote, observation_date"""
                    )
                ]
            # sqlite3's context manager commits but does not close the handle.
            conn.close()

            with Store(db) as store:
                events = store.list_events()
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]["event_id"], "legacy-event-1")
                self.assertEqual(events[0]["provider_id"], "synthetic-replay")
                self.assertEqual(events[0]["instrument_id"], "FX:USD/EUR")
                self.assertEqual(events[0]["sequence"], 739000)
                self.assertEqual(
                    events[0]["payload_json"],
                    '{"is_replay":true,"rate":"0.9001"}',
                )
                self.assertEqual(events[0]["sequence_kind"], "LOCAL_REPLAY_ORDER")

                triggers = {
                    row["name"]
                    for row in store.conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='trigger'"
                    )
                }
                self.assertIn("trg_market_data_events_no_update", triggers)
                self.assertNotIn("trg_market_data_events_no_delete", triggers)
                with self.assertRaises(sqlite3.IntegrityError):
                    store.conn.execute(
                        "UPDATE market_data_events SET payload_json='{}'"
                    )

                fx_schema_after = [
                    tuple(row)
                    for row in store.conn.execute("PRAGMA table_info(fx_rates)")
                ]
                fx_rows_after = [
                    tuple(row)
                    for row in store.conn.execute(
                        """SELECT * FROM fx_rates
                           ORDER BY provider_id, base, quote, observation_date"""
                    )
                ]
                self.assertEqual(fx_schema_after, fx_schema_before)
                self.assertEqual(fx_rows_after, fx_rows_before)

    def test_events_survive_reopen_and_daily_table_schema_is_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "events.db"
            with Store(db) as store:
                before = {
                    row["name"]
                    for row in store.conn.execute("PRAGMA table_info(fx_rates)")
                }
                store.append_events([event(1)])
            with Store(db) as store:
                after = {
                    row["name"]
                    for row in store.conn.execute("PRAGMA table_info(fx_rates)")
                }
                self.assertEqual(before, after)
                self.assertEqual(store.count_events(), 1)
                row = store.list_events()[0]
                self.assertEqual(row["payload_json"], event(1).payload_json)
                self.assertEqual(row["source_payload_sha256"], HASH)
                self.assertTrue(row["is_replay"])

    def test_invalid_event_envelopes_are_rejected(self):
        base = {
            "provider_id": "synthetic-replay",
            "instrument_id": "FX:USD/EUR",
            "event_id": "event-invalid",
            "sequence": 1,
            "event_timestamp": "2026-11-01T00:00:01Z",
            "received_timestamp": RECEIVED,
            "payload_json": '{"value":"1.0"}',
            "source_payload_sha256": HASH,
            "source_payload_bytes": 128,
            "is_replay": True,
        }
        invalid_cases = [
            {"sequence": True},
            {"sequence": -1},
            {"event_timestamp": "2026-11-01T00:00:01"},
            {"received_timestamp": "not-a-date"},
            {"payload_json": "[]"},
            {"payload_json": "{not-json"},
            {"payload_json": '{"value":NaN}'},
            {"payload_json": '{"value":1,"value":2}'},
            {"source_payload_sha256": "bad"},
            {"source_payload_bytes": -1},
            {"is_replay": False},
            {"sequence_kind": "PROVIDER_ISSUED"},
            {"instrument_id": "../outside"},
        ]
        for change in invalid_cases:
            values = dict(base)
            values.update(change)
            with self.subTest(change=change):
                with self.assertRaises(MarketDataEventError):
                    MarketDataEvent(**values)


if __name__ == "__main__":
    unittest.main()
