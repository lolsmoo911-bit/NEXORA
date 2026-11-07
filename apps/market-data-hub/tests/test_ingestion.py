import hashlib
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
from nexora_market_data.ingestion import (  # noqa: E402
    FrankfurterSource,
    IngestionError,
    ReplaySource,
)
from nexora_market_data.normalizer import normalize_payload  # noqa: E402
from nexora_market_data.provider_frankfurter import PROVIDER_ID  # noqa: E402
from nexora_market_data.store import Store  # noqa: E402

FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "replay"
RECEIVED = "2026-11-01T00:00:00+00:00"
REPLAY_ENDPOINT = "replay://local-fixtures"


class _FakeResponse:
    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class IngestionTests(unittest.TestCase):
    def _source(self, fixtures=("batch-001.json",), **kwargs):
        return ReplaySource(
            FIXTURE_ROOT,
            list(fixtures),
            provider_id="replay-local",
            endpoint=REPLAY_ENDPOINT,
            received_at=RECEIVED,
            **kwargs,
        )

    def test_replay_preserves_exact_bytes_hash_and_decimal_rates(self):
        raw = (FIXTURE_ROOT / "batch-001.json").read_bytes()
        batch = next(self._source().iter_batches())

        self.assertEqual(batch.raw_payload_sha256, hashlib.sha256(raw).hexdigest())
        self.assertEqual(batch.raw_payload_bytes, len(raw))
        self.assertEqual(batch.provider_id, "replay-local")
        self.assertEqual(batch.endpoint, REPLAY_ENDPOINT)
        self.assertEqual(batch.received_at, RECEIVED)
        self.assertEqual(batch.transport, "replay")
        self.assertTrue(batch.is_replay)
        self.assertEqual(batch.sequence, 0)
        self.assertEqual(batch.payload[0]["rate"], Decimal("0.9001"))
        self.assertIsInstance(batch.payload[0]["rate"], Decimal)

    def test_replay_is_deterministic(self):
        source = self._source()
        first = list(source.iter_batches())
        second = list(source.iter_batches())

        self.assertEqual(first, second)
        self.assertEqual(
            [batch.raw_payload_sha256 for batch in first],
            [batch.raw_payload_sha256 for batch in second],
        )

    def test_replay_orders_explicit_fixtures_and_sorts_directories(self):
        explicit = list(
            self._source(("batch-002.json", "batch-001.json")).iter_batches()
        )
        self.assertEqual([batch.sequence for batch in explicit], [0, 1])
        self.assertEqual(explicit[0].payload[0]["date"], "2026-10-31")
        self.assertEqual(explicit[1].payload[0]["date"], "2026-10-30")

        directory = list(self._source((".",)).iter_batches())
        self.assertEqual([batch.sequence for batch in directory], [0, 1])
        self.assertEqual(directory[0].payload[0]["date"], "2026-10-30")
        self.assertEqual(directory[1].payload[0]["date"], "2026-10-31")

    def test_replay_rejects_missing_invalid_and_escaping_fixtures(self):
        with self.assertRaises(IngestionError):
            self._source(("missing.json",))

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            (Path(tmp) / "outside.json").write_text("[]", encoding="utf-8")
            with self.assertRaises(IngestionError):
                ReplaySource(root, ["../outside.json"])

            invalid = root / "invalid.json"
            invalid.write_text("{not-json", encoding="utf-8")
            with self.assertRaises(IngestionError):
                ReplaySource(root, ["invalid.json"])

    def test_replay_rejects_symlink_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            outside = Path(tmp) / "outside.json"
            outside.write_text("[]", encoding="utf-8")
            link = root / "escape.json"
            try:
                link.symlink_to(outside)
            except OSError as exc:
                self.skipTest(f"symlink creation unavailable: {exc}")

            with self.assertRaises(IngestionError):
                ReplaySource(root, ["escape.json"])

    def test_frankfurter_source_maps_existing_fetch_result(self):
        body = (
            b'[\n  {"date":"2026-10-31","base":"USD","quote":"EUR",'
            b'"rate":0.89485,"providers":[]}\n]\n'
        )
        captured = {}

        def fake_opener(request, timeout=None):
            captured["url"] = request.full_url
            return _FakeResponse(200, body)

        source = FrankfurterSource(base="USD", quotes=["EUR"], opener=fake_opener)
        batches = list(source.iter_batches())

        self.assertEqual(len(batches), 1)
        batch = batches[0]
        self.assertEqual(batch.provider_id, PROVIDER_ID)
        self.assertEqual(batch.endpoint, captured["url"])
        self.assertEqual(batch.raw_payload_sha256, hashlib.sha256(body).hexdigest())
        self.assertEqual(batch.raw_payload_bytes, len(body))
        self.assertEqual(batch.transport, "http")
        self.assertFalse(batch.is_replay)
        self.assertEqual(batch.sequence, 0)
        self.assertEqual(batch.payload[0]["rate"], Decimal("0.89485"))
        self.assertIsInstance(batch.payload[0]["rate"], Decimal)

    def test_replay_payload_normalizes_with_provenance(self):
        batch = next(self._source().iter_batches())
        observations = normalize_payload(
            batch.payload,
            received_at=batch.received_at,
            endpoint=batch.endpoint,
            provider_id=batch.provider_id,
            raw_payload_sha256=batch.raw_payload_sha256,
            raw_payload_bytes=batch.raw_payload_bytes,
        )

        self.assertEqual(len(observations), 2)
        for observation in observations:
            self.assertEqual(observation.provider_id, "replay-local")
            self.assertEqual(observation.received_at, RECEIVED)
            self.assertEqual(observation.endpoint, REPLAY_ENDPOINT)
            self.assertEqual(
                observation.raw_payload_sha256, batch.raw_payload_sha256
            )
            self.assertEqual(
                observation.raw_payload_bytes, batch.raw_payload_bytes
            )
            self.assertEqual(observation.normalization_version, NORMALIZATION_VERSION)
            self.assertEqual(observation.schema_version, OBSERVATION_SCHEMA_VERSION)

    def test_replay_payload_persists_through_existing_store(self):
        raw = (FIXTURE_ROOT / "batch-001.json").read_bytes()
        batch = next(self._source().iter_batches())
        observations = normalize_payload(
            batch.payload,
            received_at=batch.received_at,
            endpoint=batch.endpoint,
            provider_id=batch.provider_id,
            raw_payload_sha256=batch.raw_payload_sha256,
            raw_payload_bytes=batch.raw_payload_bytes,
        )

        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "replay.db")
            try:
                counts = store.upsert(observations)
                self.assertEqual(counts, {"inserted": 2, "updated": 0, "total": 2})
                rows = {row["quote"]: row for row in store.list_rates()}
                self.assertEqual(set(rows), {"EUR", "GBP"})
                self.assertEqual(
                    rows["EUR"]["raw_payload_sha256"],
                    hashlib.sha256(raw).hexdigest(),
                )
                self.assertEqual(rows["EUR"]["raw_payload_bytes"], len(raw))
                self.assertEqual(rows["EUR"]["provider_id"], "replay-local")
                self.assertEqual(rows["EUR"]["endpoint"], REPLAY_ENDPOINT)
                self.assertEqual(rows["EUR"]["received_at"], RECEIVED)
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
