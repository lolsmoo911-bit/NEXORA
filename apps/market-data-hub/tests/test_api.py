import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexora_market_data import (  # noqa: E402
    DISCLAIMER,
    NORMALIZATION_VERSION,
    OBSERVATION_SCHEMA_VERSION,
)
from nexora_market_data.api import create_server  # noqa: E402
from nexora_market_data.normalizer import normalize_payload  # noqa: E402
from nexora_market_data.store import Store  # noqa: E402

RECEIVED = "2026-11-01T00:00:00+00:00"
ENDPOINT = "https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR&expand=providers"
RAW_SHA256 = "c" * 64


def seed(store):
    observations = normalize_payload(
        [
            {
                "date": "2026-10-31",
                "base": "USD",
                "quote": "EUR",
                "rate": Decimal("0.89485"),
                "providers": [
                    {"key": "ECB", "date": "2026-10-30", "rate": Decimal("0.89509")}
                ],
            }
        ],
        RECEIVED,
        ENDPOINT,
        raw_payload_sha256=RAW_SHA256,
        raw_payload_bytes=789,
    )
    store.upsert(observations)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / "api.db")
        seed(self.store)
        self.server = create_server(self.store, port=0, as_of="2026-11-01")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.store.close()
        self.tmp.cleanup()

    def _get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_health(self):
        status, body = self._get("/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["stored_observations"], 1)
        self.assertEqual(body["data_status"], "DAILY_REFERENCE")

    def test_rates_endpoint(self):
        status, body = self._get("/api/v1/fx/rates")
        self.assertEqual(status, 200)
        self.assertEqual(body["data_status"], "DAILY_REFERENCE")
        self.assertEqual(body["price_type"], "MID")
        self.assertFalse(body["executable"])
        self.assertEqual(body["disclaimer"], DISCLAIMER)
        self.assertEqual(body["count"], 1)
        row = body["rates"][0]
        self.assertEqual(row["base"], "USD")
        self.assertEqual(row["quote"], "EUR")
        self.assertEqual(row["rate"], "0.89485")
        self.assertEqual(row["provider_keys"], ["ECB"])
        self.assertEqual(row["excluded_provider_keys"], [])
        self.assertEqual(row["provider_metadata_status"], "PROVIDED")
        self.assertEqual(row["provider_contributions"][0]["key"], "ECB")
        self.assertEqual(row["quality_status"], "FRESH")
        self.assertEqual(row["age_days"], 1)
        self.assertIn("ECB", row["attribution"])
        self.assertEqual(row["raw_payload_sha256"], RAW_SHA256)
        self.assertEqual(row["raw_payload_bytes"], 789)
        self.assertEqual(row["normalization_version"], NORMALIZATION_VERSION)
        self.assertEqual(row["schema_version"], OBSERVATION_SCHEMA_VERSION)
        self.assertEqual(
            body["provenance"]["raw_payload_sha256_scope"],
            "exact provider HTTP response body bytes; not re-serialized JSON",
        )
        self.assertEqual(body["provenance"]["normalization_version"], NORMALIZATION_VERSION)
        self.assertEqual(body["provenance"]["schema_version"], OBSERVATION_SCHEMA_VERSION)
        self.assertEqual(body["as_of"], "2026-11-01")
        self.assertEqual(body["max_age_days"], 4)

    def test_quality_summary_endpoint(self):
        status, body = self._get("/api/v1/quality/summary")
        self.assertEqual(status, 200)
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["fresh"], 1)
        self.assertEqual(body["stale"], 0)
        self.assertEqual(body["unknown"], 0)
        self.assertEqual(body["latest_observation_date"], "2026-10-31")
        self.assertEqual(body["as_of"], "2026-11-01")
        self.assertEqual(body["max_age_days"], 4)
        self.assertIn("holiday", body["limitations"])

    def test_provider_health_endpoint(self):
        self.store.record_attempt(
            provider_id="frankfurter-blended",
            endpoint="https://example.test/v2/rates",
            attempted_at="2026-11-01T00:00:00+00:00",
            completed_at="2026-11-01T00:00:01+00:00",
            duration_ms=1000,
            http_status=200,
            outcome="OK",
            rows_fetched=1,
        )
        status, body = self._get("/api/v1/providers/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "OK")
        self.assertEqual(body["consecutive_failures"], 0)
        self.assertEqual(body["latest_attempt"]["outcome"], "OK")
        self.assertEqual(body["latest_attempt"]["rows_fetched"], 1)
        self.assertFalse(body["internet_status_asserted"])

    def test_quality_gaps_endpoint(self):
        observations = normalize_payload(
            [
                {
                    "date": "2026-10-26",
                    "base": "USD",
                    "quote": "GBP",
                    "rate": Decimal("0.8000"),
                    "providers": [],
                },
                {
                    "date": "2026-10-29",
                    "base": "USD",
                    "quote": "GBP",
                    "rate": Decimal("0.8100"),
                    "providers": [],
                },
            ],
            RECEIVED,
            ENDPOINT,
        )
        self.store.upsert(observations)
        status, body = self._get("/api/v1/quality/gaps")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "POTENTIAL_WEEKDAY_GAP")
        gbp_gaps = [
            item
            for item in body["gaps"]
            if item["base"] == "USD" and item["quote"] == "GBP"
        ]
        self.assertEqual(
            [item["missing_date"] for item in gbp_gaps],
            ["2026-10-27", "2026-10-28"],
        )
        self.assertIn("holiday", body["limitations"])

    def test_static_page_has_notice(self):
        with urllib.request.urlopen(self.base + "/", timeout=5) as response:
            html = response.read().decode("utf-8")
        self.assertEqual(response.status, 200)
        self.assertIn("not a live executable quote", html)
        self.assertIn("Daily reference rate", html)

    def test_post_rejected(self):
        request = urllib.request.Request(
            self.base + "/api/v1/fx/rates", data=b"{}", method="POST"
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(ctx.exception.code, 405)

    def test_unknown_api_returns_404(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(self.base + "/api/v1/orders", timeout=5)
        self.assertEqual(ctx.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
