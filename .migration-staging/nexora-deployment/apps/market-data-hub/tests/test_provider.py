import hashlib
import json
import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexora_market_data.provider_frankfurter import (  # noqa: E402
    ProviderError,
    build_url,
    fetch_rates,
)


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


class ProviderTests(unittest.TestCase):
    def test_build_url_includes_parameters(self):
        url = build_url("usd", ["eur", "gbp"])
        self.assertIn("/v2/rates?", url)
        self.assertIn("base=USD", url)
        self.assertIn("quotes=EUR%2CGBP", url)
        self.assertIn("expand=providers", url)

    def test_fetch_decodes_numbers_as_decimal(self):
        captured = {}

        def fake_opener(request, timeout=None):
            captured["url"] = request.full_url
            body = json.dumps(
                [
                    {
                        "date": "2026-10-31",
                        "base": "USD",
                        "quote": "EUR",
                        "rate": 0.89485,
                        "providers": [{"key": "ECB", "date": "2026-10-30", "rate": 0.89509}],
                    }
                ]
            ).encode("utf-8")
            return _FakeResponse(200, body)

        result = fetch_rates(base="USD", quotes=["EUR"], opener=fake_opener)
        self.assertEqual(result.http_status, 200)
        self.assertEqual(result.payload[0]["rate"], Decimal("0.89485"))
        self.assertIsInstance(result.payload[0]["rate"], Decimal)
        self.assertIn("expand=providers", captured["url"])
        self.assertTrue(result.received_at.endswith("+00:00"))

    def test_fetch_hashes_exact_response_bytes(self):
        body = (
            b'[\n  {"date":"2026-10-31","base":"USD","quote":"EUR",'
            b'"rate":0.89485,"providers":[]}\n]\n'
        )

        def fake_opener(request, timeout=None):
            return _FakeResponse(200, body)

        first = fetch_rates(base="USD", quotes=["EUR"], opener=fake_opener)
        second = fetch_rates(base="USD", quotes=["EUR"], opener=fake_opener)
        expected = hashlib.sha256(body).hexdigest()
        self.assertEqual(first.raw_payload_sha256, expected)
        self.assertEqual(second.raw_payload_sha256, expected)
        self.assertEqual(first.raw_payload_bytes, len(body))
        self.assertNotEqual(first.raw_payload_sha256, "0" * 64)

    def test_fetch_rejects_invalid_json(self):
        def fake_opener(request, timeout=None):
            return _FakeResponse(200, b"not-json")

        with self.assertRaises(ProviderError):
            fetch_rates(opener=fake_opener)

    def test_fetch_rejects_non_200(self):
        def fake_opener(request, timeout=None):
            return _FakeResponse(503, b"[]")

        with self.assertRaises(ProviderError):
            fetch_rates(opener=fake_opener)

    def test_fetch_rejects_network_error(self):
        def fake_opener(request, timeout=None):
            raise OSError("network down")

        with self.assertRaises(ProviderError):
            fetch_rates(opener=fake_opener)


if __name__ == "__main__":
    unittest.main()
