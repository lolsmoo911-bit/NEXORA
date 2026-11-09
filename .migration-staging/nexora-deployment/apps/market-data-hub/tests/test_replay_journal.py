import hashlib
import json
import sys
import tempfile
import unittest
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexora_market_data.events import (  # noqa: E402
    LOCAL_REPLAY_SEQUENCE_KIND,
    MarketDataEventConflict,
)
from nexora_market_data.ingestion import (  # noqa: E402
    REPLAY_ENDPOINT,
    REPLAY_PROVIDER_ID,
    REPLAY_RECEIVED_AT,
    ReplaySource,
)
from nexora_market_data.replay_journal import (  # noqa: E402
    EVENT_TIME_KIND,
    RECEIVED_TIME_KIND,
    ReplayJournalError,
    journal_replay,
)
from nexora_market_data.store import Store  # noqa: E402

FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "replay"
FIXTURES = ("batch-001.json", "batch-002.json")


class _BatchSource:
    def __init__(self, batches) -> None:
        self.provider_id = REPLAY_PROVIDER_ID
        self._batches = list(batches)

    def iter_batches(self):
        yield from self._batches


def _source(fixtures=FIXTURES, **kwargs):
    return ReplaySource(
        FIXTURE_ROOT,
        list(fixtures),
        provider_id=REPLAY_PROVIDER_ID,
        endpoint=REPLAY_ENDPOINT,
        received_at=REPLAY_RECEIVED_AT,
        **kwargs,
    )


def _fixture_bytes(name):
    return (FIXTURE_ROOT / name).read_bytes()


class ReplayJournalTests(unittest.TestCase):
    def test_two_fixtures_journal_all_observations_with_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "replay.db") as store:
                summary = journal_replay(_source(), store)

                self.assertEqual(
                    summary,
                    {
                        "batches_read": 2,
                        "observations_journaled": 3,
                        "inserted": 3,
                        "duplicates": 0,
                    },
                )
                self.assertEqual(store.count_events(), 3)
                # The daily reference table is not touched.
                self.assertEqual(store.count(), 0)
                self.assertEqual(store.list_rates(), [])

                rows = {
                    (row["instrument_id"], row["event_id"]): row
                    for row in store.list_events()
                }
                self.assertEqual(
                    set(rows),
                    {
                        ("FX:USD/EUR", "replay:FX:USD/EUR:2026-10-30"),
                        ("FX:USD/GBP", "replay:FX:USD/GBP:2026-10-30"),
                        ("FX:USD/EUR", "replay:FX:USD/EUR:2026-10-31"),
                    },
                )
                for row in rows.values():
                    self.assertEqual(row["provider_id"], REPLAY_PROVIDER_ID)
                    self.assertEqual(
                        row["sequence_kind"], LOCAL_REPLAY_SEQUENCE_KIND
                    )
                    self.assertTrue(row["is_replay"])
                    self.assertEqual(
                        row["received_timestamp"], "1970-01-01T00:00:00.000000Z"
                    )

    def test_second_replay_of_same_fixtures_is_all_duplicates(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "replay.db") as store:
                journal_replay(_source(), store)
                summary = journal_replay(_source(), store)

                self.assertEqual(summary["batches_read"], 2)
                self.assertEqual(summary["observations_journaled"], 3)
                self.assertEqual(summary["inserted"], 0)
                self.assertEqual(summary["duplicates"], 3)
                self.assertEqual(store.count_events(), 3)

    def test_sequence_order_is_stable_and_date_derived_per_instrument(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "replay.db") as store:
                journal_replay(_source(), store)
                rows = store.list_events(
                    provider_id=REPLAY_PROVIDER_ID,
                    instrument_id="FX:USD/EUR",
                )
                self.assertEqual(
                    [row["event_id"] for row in rows],
                    [
                        "replay:FX:USD/EUR:2026-10-30",
                        "replay:FX:USD/EUR:2026-10-31",
                    ],
                )
                self.assertEqual(
                    [row["sequence"] for row in rows],
                    [
                        _ordinal("2026-10-30"),
                        _ordinal("2026-10-31"),
                    ],
                )
                # No provider-issued sequence is implied.
                self.assertTrue(
                    all(row["sequence_kind"] == "LOCAL_REPLAY_ORDER" for row in rows)
                )

    def test_event_times_are_explicitly_synthetic(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "replay.db") as store:
                journal_replay(_source(), store)
                for row in store.list_events():
                    payload = json.loads(row["payload_json"], parse_float=Decimal)
                    expected_date = row["event_id"].rsplit(":", 1)[1]
                    self.assertEqual(
                        row["event_timestamp"],
                        f"{expected_date}T00:00:00.000000Z",
                    )
                    self.assertTrue(payload["is_replay"])
                    self.assertEqual(payload["event_time_kind"], EVENT_TIME_KIND)
                    self.assertEqual(
                        payload["received_time_kind"], RECEIVED_TIME_KIND
                    )
                    self.assertEqual(
                        payload["received_timestamp"], row["received_timestamp"]
                    )
                    self.assertEqual(payload["sequence_kind"], "LOCAL_REPLAY_ORDER")

    def test_raw_hash_and_byte_count_are_stored_per_batch(self):
        raw_001 = _fixture_bytes("batch-001.json")
        raw_002 = _fixture_bytes("batch-002.json")
        expected = {
            "2026-10-30": (
                hashlib.sha256(raw_001).hexdigest(),
                len(raw_001),
            ),
            "2026-10-31": (
                hashlib.sha256(raw_002).hexdigest(),
                len(raw_002),
            ),
        }
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "replay.db") as store:
                journal_replay(_source(), store)
                for row in store.list_events():
                    observation_date = row["event_id"].rsplit(":", 1)[1]
                    digest, size = expected[observation_date]
                    self.assertEqual(row["source_payload_sha256"], digest)
                    self.assertEqual(row["source_payload_bytes"], size)
                    payload = json.loads(row["payload_json"])
                    self.assertEqual(payload["raw_payload_sha256"], digest)
                    self.assertEqual(payload["raw_payload_bytes"], size)

    def test_decimal_rate_text_is_preserved_without_float_conversion(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "replay.db") as store:
                journal_replay(_source(("batch-001.json",)), store)
                rows = {
                    row["instrument_id"]: row for row in store.list_events()
                }
                eur = json.loads(
                    rows["FX:USD/EUR"]["payload_json"], parse_float=Decimal
                )
                gbp = json.loads(
                    rows["FX:USD/GBP"]["payload_json"], parse_float=Decimal
                )
                self.assertIsInstance(eur["rate"], str)
                self.assertIsInstance(gbp["rate"], str)
                self.assertEqual(eur["rate"], "0.9001")
                self.assertEqual(gbp["rate"], "0.7802")

    def test_non_replay_batch_is_rejected_before_anything_is_written(self):
        batches = list(_source(("batch-001.json",)).iter_batches())
        live = replace(batches[0], transport="http", is_replay=False)
        source = _BatchSource([batches[0], live])

        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "replay.db") as store:
                with self.assertRaises(ReplayJournalError):
                    journal_replay(source, store)
                self.assertEqual(store.count_events(), 0)
                self.assertEqual(store.count(), 0)

    def test_changed_payload_for_same_identity_is_a_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "replay.db") as store:
                journal_replay(_source(("batch-001.json",)), store)

                original = list(
                    _source(("batch-001.json",)).iter_batches()
                )[0]
                changed_payload = json.loads(
                    json.dumps(original.payload, default=str), parse_float=Decimal
                )
                changed_payload[0]["rate"] = Decimal("0.9999")
                changed = replace(original, payload=changed_payload)

                with self.assertRaises(MarketDataEventConflict):
                    journal_replay(_BatchSource([changed]), store)

                self.assertEqual(store.count_events(), 2)
                rows = store.list_events(
                    provider_id=REPLAY_PROVIDER_ID,
                    instrument_id="FX:USD/EUR",
                )
                payload = json.loads(rows[0]["payload_json"])
                self.assertEqual(payload["rate"], "0.9001")


def _ordinal(value: str) -> int:
    from datetime import date

    return date.fromisoformat(value).toordinal()


if __name__ == "__main__":
    unittest.main()
