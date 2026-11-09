import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexora_market_data import (  # noqa: E402
    NORMALIZATION_VERSION,
    OBSERVATION_SCHEMA_VERSION,
)
from nexora_market_data.normalizer import (  # noqa: E402
    NormalizationError,
    normalize_payload,
)

RECEIVED = "2026-11-01T00:00:00+00:00"
RAW_SHA256 = "a" * 64
ENDPOINT = "https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR,JPY&expand=providers"


def sample_payload():
    return [
        {
            "date": "2026-10-31",
            "base": "USD",
            "quote": "EUR",
            "rate": Decimal("0.89485"),
            "providers": [
                {"key": "ECB", "date": "2026-10-30", "rate": Decimal("0.89509")},
                {"key": "IMF", "date": "2026-10-30", "rate": Decimal("0.89509")},
                {"key": "BAD", "date": "2026-10-30", "rate": Decimal("9.9"), "excluded": True},
            ],
        },
        {
            "date": "2026-10-31",
            "base": "USD",
            "quote": "JPY",
            "rate": 157.66,
            "providers": [{"key": "ECB", "date": "2026-10-30", "rate": 157.25}],
        },
    ]


class NormalizerTests(unittest.TestCase):
    def test_valid_payload_normalizes(self):
        observations = normalize_payload(sample_payload(), RECEIVED, ENDPOINT)
        self.assertEqual(len(observations), 2)
        first = observations[0]
        self.assertEqual(first.base, "USD")
        self.assertEqual(first.quote, "EUR")
        self.assertEqual(first.rate, Decimal("0.89485"))
        self.assertIsInstance(first.rate, Decimal)
        self.assertEqual(first.data_status, "DAILY_REFERENCE")
        self.assertEqual(first.price_type, "MID")
        self.assertFalse(first.executable)
        self.assertEqual(first.provider_keys, ("ECB", "IMF"))
        self.assertEqual(first.excluded_provider_keys, ("BAD",))
        self.assertEqual(first.provider_metadata_status, "PROVIDED")
        self.assertEqual(len(first.provider_contributions), 3)
        self.assertIn("ECB", first.attribution)
        self.assertNotIn("BAD", first.provider_keys)
        excluded = [
            item for item in first.provider_contributions if item.key == "BAD"
        ][0]
        self.assertTrue(excluded.excluded)
        self.assertEqual(excluded.rate, "9.9")
        self.assertEqual(first.observation_date, "2026-10-31")
        self.assertIsNone(first.raw_payload_sha256)
        self.assertIsNone(first.raw_payload_bytes)
        self.assertEqual(first.normalization_version, NORMALIZATION_VERSION)
        self.assertEqual(first.schema_version, OBSERVATION_SCHEMA_VERSION)

    def test_provenance_metadata_is_copied_to_every_observation(self):
        observations = normalize_payload(
            sample_payload(),
            RECEIVED,
            ENDPOINT,
            raw_payload_sha256=RAW_SHA256.upper(),
            raw_payload_bytes=1234,
        )
        for observation in observations:
            self.assertEqual(observation.raw_payload_sha256, RAW_SHA256)
            self.assertEqual(observation.raw_payload_bytes, 1234)
            self.assertEqual(observation.normalization_version, NORMALIZATION_VERSION)
            self.assertEqual(observation.schema_version, OBSERVATION_SCHEMA_VERSION)

    def test_invalid_provenance_hash_rejected(self):
        with self.assertRaises(NormalizationError):
            normalize_payload(
                sample_payload(),
                RECEIVED,
                ENDPOINT,
                raw_payload_sha256="not-a-sha256",
            )

    def test_missing_provider_array_is_documented_ambiguity(self):
        payload = sample_payload()
        del payload[0]["providers"]
        observations = normalize_payload(payload, RECEIVED, ENDPOINT)
        first = observations[0]
        self.assertEqual(first.provider_keys, ())
        self.assertEqual(first.provider_contributions, ())
        self.assertEqual(first.provider_metadata_status, "NOT_PROVIDED_OR_PEGGED")
        self.assertIn("not provided", first.attribution)

    def test_empty_provider_array_is_documented_ambiguity(self):
        payload = sample_payload()
        payload[0]["providers"] = []
        observations = normalize_payload(payload, RECEIVED, ENDPOINT)
        self.assertEqual(observations[0].provider_metadata_status, "NOT_PROVIDED_OR_PEGGED")

    def test_all_excluded_providers_are_retained(self):
        payload = sample_payload()
        payload[0]["providers"] = [
            {"key": "BAD", "date": "2026-10-30", "rate": "9.9", "excluded": True}
        ]
        observations = normalize_payload(payload, RECEIVED, ENDPOINT)
        first = observations[0]
        self.assertEqual(first.provider_keys, ())
        self.assertEqual(first.excluded_provider_keys, ("BAD",))
        self.assertIn("excluded", first.attribution)

    def test_non_object_provider_entry_rejected(self):
        payload = sample_payload()
        payload[0]["providers"] = ["ECB"]
        with self.assertRaises(NormalizationError):
            normalize_payload(payload, RECEIVED, ENDPOINT)

    def test_future_observation_rejected_when_as_of_supplied(self):
        with self.assertRaises(NormalizationError):
            normalize_payload(
                sample_payload(), RECEIVED, ENDPOINT, as_of="2026-10-30"
            )

    def test_invalid_currency_rejected(self):
        payload = sample_payload()
        payload[0]["quote"] = "EURO"
        with self.assertRaises(NormalizationError):
            normalize_payload(payload, RECEIVED, ENDPOINT)

    def test_identical_base_and_quote_rejected(self):
        payload = sample_payload()
        payload[0]["quote"] = "USD"
        with self.assertRaises(NormalizationError):
            normalize_payload(payload, RECEIVED, ENDPOINT)

    def test_negative_rate_rejected(self):
        payload = sample_payload()
        payload[0]["rate"] = -1
        with self.assertRaises(NormalizationError):
            normalize_payload(payload, RECEIVED, ENDPOINT)

    def test_non_numeric_rate_rejected(self):
        payload = sample_payload()
        payload[0]["rate"] = "abc"
        with self.assertRaises(NormalizationError):
            normalize_payload(payload, RECEIVED, ENDPOINT)

    def test_invalid_date_rejected(self):
        payload = sample_payload()
        payload[0]["date"] = "2026-13-40"
        with self.assertRaises(NormalizationError):
            normalize_payload(payload, RECEIVED, ENDPOINT)

    def test_missing_field_rejected(self):
        payload = sample_payload()
        del payload[0]["rate"]
        with self.assertRaises(NormalizationError):
            normalize_payload(payload, RECEIVED, ENDPOINT)

    def test_non_array_payload_rejected(self):
        with self.assertRaises(NormalizationError):
            normalize_payload({"rate": 1}, RECEIVED, ENDPOINT)

    def test_empty_payload_rejected(self):
        with self.assertRaises(NormalizationError):
            normalize_payload([], RECEIVED, ENDPOINT)

    def test_duplicate_pair_date_rejected(self):
        payload = sample_payload()
        payload.append(dict(payload[0]))
        with self.assertRaises(NormalizationError):
            normalize_payload(payload, RECEIVED, ENDPOINT)


if __name__ == "__main__":
    unittest.main()
