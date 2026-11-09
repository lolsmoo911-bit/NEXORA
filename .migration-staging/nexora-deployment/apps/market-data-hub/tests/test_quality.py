import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexora_market_data.quality import (  # noqa: E402
    DEFAULT_MAX_AGE_DAYS,
    FRESH,
    FUTURE_DATE,
    STALE,
    UNKNOWN,
    evaluate_observation,
    potential_weekday_gaps,
    quality_summary,
)


class QualityTests(unittest.TestCase):
    def test_fresh_observation(self):
        result = evaluate_observation("2026-10-31", "2026-11-01")
        self.assertEqual(result["quality_status"], FRESH)
        self.assertEqual(result["age_days"], 1)

    def test_weekend_is_fresh_under_provisional_threshold(self):
        # Friday observation, Monday evaluation: 3 calendar days.
        result = evaluate_observation("2026-10-30", "2026-11-02")
        self.assertEqual(result["quality_status"], FRESH)
        self.assertEqual(result["age_days"], 3)
        self.assertEqual(DEFAULT_MAX_AGE_DAYS, 4)

    def test_stale_observation(self):
        result = evaluate_observation("2026-10-20", "2026-11-01")
        self.assertEqual(result["quality_status"], STALE)
        self.assertEqual(result["age_days"], 12)

    def test_future_observation_is_flagged(self):
        result = evaluate_observation("2026-11-05", "2026-11-01")
        self.assertEqual(result["quality_status"], FUTURE_DATE)
        self.assertEqual(result["age_days"], -4)

    def test_unknown_observation_date(self):
        result = evaluate_observation("not-a-date", "2026-11-01")
        self.assertEqual(result["quality_status"], UNKNOWN)
        self.assertIsNone(result["age_days"])

    def test_summary_counts_and_latest_dates(self):
        rows = [
            {"observation_date": "2026-10-31", "received_at": "2026-11-01T00:00:00+00:00"},
            {"observation_date": "2026-10-20", "received_at": "2026-10-21T00:00:00+00:00"},
            {"observation_date": "2026-11-05", "received_at": "2026-11-01T00:00:00+00:00"},
            {"observation_date": "bad", "received_at": "2026-11-01T00:00:00+00:00"},
        ]
        summary = quality_summary(rows, "2026-11-01")
        self.assertEqual(summary["total"], 4)
        self.assertEqual(summary["fresh"], 1)
        self.assertEqual(summary["stale"], 1)
        self.assertEqual(summary["future_date"], 1)
        self.assertEqual(summary["unknown"], 1)
        self.assertEqual(summary["latest_observation_date"], "2026-11-05")
        self.assertEqual(summary["latest_received_at"], "2026-11-01T00:00:00+00:00")


class GapTests(unittest.TestCase):
    def test_friday_to_monday_has_no_weekday_gap(self):
        rows = [
            {"base": "USD", "quote": "EUR", "observation_date": "2026-10-30"},
            {"base": "USD", "quote": "EUR", "observation_date": "2026-11-02"},
        ]
        result = potential_weekday_gaps(rows)
        self.assertEqual(result["count"], 0)
        self.assertFalse(result["truncated"])

    def test_monday_to_thursday_reports_tuesday_and_wednesday(self):
        rows = [
            {"base": "USD", "quote": "GBP", "observation_date": "2026-10-26"},
            {"base": "USD", "quote": "GBP", "observation_date": "2026-10-29"},
        ]
        result = potential_weekday_gaps(rows)
        self.assertEqual(result["status"], "POTENTIAL_WEEKDAY_GAP")
        self.assertEqual(
            [item["missing_date"] for item in result["gaps"]],
            ["2026-10-27", "2026-10-28"],
        )

    def test_single_observation_cannot_establish_gap(self):
        rows = [{"base": "USD", "quote": "JPY", "observation_date": "2026-10-26"}]
        result = potential_weekday_gaps(rows)
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["gaps"], [])

    def test_gap_output_is_capped(self):
        rows = [
            {"base": "USD", "quote": "CHF", "observation_date": "2026-01-01"},
            {"base": "USD", "quote": "CHF", "observation_date": "2026-02-01"},
        ]
        result = potential_weekday_gaps(rows, max_gaps=3)
        self.assertEqual(result["count"], 3)
        self.assertTrue(result["truncated"])


if __name__ == "__main__":
    unittest.main()
