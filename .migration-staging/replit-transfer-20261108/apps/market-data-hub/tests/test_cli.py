import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexora_market_data import (  # noqa: E402
    NORMALIZATION_VERSION,
    OBSERVATION_SCHEMA_VERSION,
)
from nexora_market_data.cli import (  # noqa: E402
    APP_ROOT,
    DEFAULT_DB,
    main,
)
from nexora_market_data.provider_frankfurter import (  # noqa: E402
    FetchResult,
    ProviderError,
)
from nexora_market_data.store import Store  # noqa: E402

RAW_SHA256 = "d" * 64
FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "replay"


def fetch_result():
    return FetchResult(
        payload=[
            {
                "date": "2026-10-31",
                "base": "USD",
                "quote": "EUR",
                "rate": Decimal("0.89485"),
                "providers": [
                    {
                        "key": "ECB",
                        "date": "2026-10-30",
                        "rate": Decimal("0.89509"),
                    }
                ],
            }
        ],
        endpoint="https://example.test/v2/rates?base=USD&quotes=EUR",
        received_at="2026-11-01T00:00:00+00:00",
        http_status=200,
        raw_payload_sha256=RAW_SHA256,
        raw_payload_bytes=321,
    )


class CliTests(unittest.TestCase):
    def test_successful_fetch_records_attempt(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "cli.db"
            with patch(
                "nexora_market_data.cli.fetch_rates", return_value=fetch_result()
            ):
                with redirect_stdout(io.StringIO()):
                    code = main(
                        ["fetch", "--db", str(db), "--capture", ""]
                    )
            self.assertEqual(code, 0)
            with Store(db) as store:
                health = store.provider_health()
                self.assertEqual(health["attempts_recorded"], 1)
                self.assertEqual(health["status"], "OK")
                self.assertEqual(health["consecutive_failures"], 0)
                self.assertEqual(health["latest_attempt"]["rows_fetched"], 1)
                self.assertEqual(health["latest_attempt"]["http_status"], 200)

    def test_successful_fetch_exposes_and_captures_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "cli.db"
            capture = Path(tmp) / "capture.json"
            with patch(
                "nexora_market_data.cli.fetch_rates", return_value=fetch_result()
            ):
                with redirect_stdout(io.StringIO()) as out:
                    code = main(
                        [
                            "fetch",
                            "--db",
                            str(db),
                            "--capture",
                            str(capture),
                        ]
                    )
            self.assertEqual(code, 0)
            summary = json.loads(out.getvalue())
            self.assertEqual(summary["raw_payload_sha256"], RAW_SHA256)
            self.assertEqual(summary["raw_payload_bytes"], 321)
            self.assertEqual(summary["normalization_version"], NORMALIZATION_VERSION)
            self.assertEqual(summary["schema_version"], OBSERVATION_SCHEMA_VERSION)

            captured = json.loads(capture.read_text(encoding="utf-8"))
            self.assertEqual(captured["raw_payload_sha256"], RAW_SHA256)
            self.assertEqual(captured["raw_payload_bytes"], 321)
            self.assertEqual(
                captured["raw_payload_sha256_scope"],
                "exact provider HTTP response body bytes; not re-serialized JSON",
            )
            self.assertEqual(
                captured["observations"][0]["raw_payload_sha256"], RAW_SHA256
            )
            self.assertEqual(
                captured["observations"][0]["normalization_version"],
                NORMALIZATION_VERSION,
            )
            self.assertEqual(
                captured["observations"][0]["schema_version"],
                OBSERVATION_SCHEMA_VERSION,
            )

    def test_failed_fetch_records_error_attempt(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "cli.db"
            with patch(
                "nexora_market_data.cli.fetch_rates",
                side_effect=ProviderError("boom", http_status=503),
            ):
                with redirect_stderr(io.StringIO()):
                    code = main(
                        ["fetch", "--db", str(db), "--capture", ""]
                    )
            self.assertEqual(code, 1)
            with Store(db) as store:
                health = store.provider_health()
                self.assertEqual(health["attempts_recorded"], 1)
                self.assertEqual(health["status"], "ERROR")
                self.assertEqual(health["consecutive_failures"], 1)
                self.assertEqual(health["latest_attempt"]["http_status"], 503)
                self.assertEqual(health["latest_attempt"]["error_class"], "ProviderError")
                self.assertEqual(health["latest_attempt"]["error_message"], "boom")


    def test_replay_and_audit_require_explicit_db_before_creating_any_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            previous = Path.cwd()
            os.chdir(tmp)
            try:
                for command in ("replay-local", "audit-events"):
                    with self.subTest(command=command):
                        with redirect_stderr(io.StringIO()):
                            with self.assertRaises(SystemExit) as raised:
                                main([command])
                        self.assertEqual(raised.exception.code, 2)
                        self.assertEqual(list(Path(tmp).iterdir()), [])
            finally:
                os.chdir(previous)

    def test_replay_and_audit_reject_var_paths_before_opening_store(self):
        targets = (
            DEFAULT_DB,
            APP_ROOT / "var" / "scratch-replay-test.db",
        )
        for command in ("replay-local", "audit-events"):
            for target in targets:
                with self.subTest(command=command, target=str(target)):
                    argv = [command, "--db", str(target)]
                    if command == "replay-local":
                        argv.extend(["--fixtures", str(FIXTURE_ROOT)])
                    with patch("nexora_market_data.cli.Store") as store_class:
                        with redirect_stderr(io.StringIO()):
                            code = main(argv)
                    self.assertEqual(code, 1)
                    store_class.assert_not_called()
        self.assertFalse((APP_ROOT / "var" / "scratch-replay-test.db").exists())

    def test_replay_local_prints_counts_only_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "scratch.db"
            argv = [
                "replay-local",
                "--db",
                str(db),
                "--fixtures",
                str(FIXTURE_ROOT),
            ]
            with redirect_stdout(io.StringIO()) as out:
                code = main(argv)
            self.assertEqual(code, 0)
            first = json.loads(out.getvalue())
            self.assertEqual(
                first,
                {
                    "batches_read": 2,
                    "observations_journaled": 3,
                    "inserted": 3,
                    "duplicates": 0,
                },
            )
            rendered = out.getvalue()
            for forbidden in ("0.9001", "rate", "payload", "raw_record_json"):
                self.assertNotIn(forbidden, rendered)

            with redirect_stdout(io.StringIO()) as out:
                code = main(argv)
            self.assertEqual(code, 0)
            second = json.loads(out.getvalue())
            self.assertEqual(
                second,
                {
                    "batches_read": 2,
                    "observations_journaled": 3,
                    "inserted": 0,
                    "duplicates": 3,
                },
            )

            with Store(db) as store:
                audit = store.audit_events()
            self.assertEqual(audit["scanned"], 3)
            self.assertEqual(audit["valid"], 3)
            self.assertEqual(audit["invalid"], 0)

    def test_audit_events_reads_compact_json_without_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "scratch.db"
            with redirect_stdout(io.StringIO()):
                self.assertEqual(
                    main(
                        [
                            "replay-local",
                            "--db",
                            str(db),
                            "--fixtures",
                            str(FIXTURE_ROOT),
                        ]
                    ),
                    0,
                )
            with Store(db) as store:
                before = [
                    tuple(row)
                    for row in store.conn.execute(
                        "SELECT * FROM market_data_events ORDER BY event_row_id"
                    )
                ]
            digest_before = hashlib.sha256(db.read_bytes()).hexdigest()

            with redirect_stdout(io.StringIO()) as out:
                code = main(
                    ["audit-events", "--db", str(db), "--max-errors", "100"]
                )
            self.assertEqual(code, 0)
            digest_after = hashlib.sha256(db.read_bytes()).hexdigest()
            self.assertEqual(digest_before, digest_after)
            result = json.loads(out.getvalue())
            self.assertEqual(
                result,
                {
                    "scanned": 3,
                    "valid": 3,
                    "invalid": 0,
                    "errors": [],
                    "errors_truncated": False,
                    "max_errors": 100,
                },
            )
            rendered = out.getvalue()
            for forbidden in (
                "0.9001",
                "rate",
                "payload",
                "raw_record_json",
                "event_id",
            ):
                self.assertNotIn(forbidden, rendered)

            with Store(db, read_only=True) as store:
                after = [
                    tuple(row)
                    for row in store.conn.execute(
                        "SELECT * FROM market_data_events ORDER BY event_row_id"
                    )
                ]
            self.assertEqual(before, after)

    def test_audit_events_rejects_invalid_max_errors_without_creating_db(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "never-created.db"
            for value in ("0", "-1", "1001"):
                with self.subTest(value=value):
                    with redirect_stderr(io.StringIO()):
                        code = main(
                            [
                                "audit-events",
                                "--db",
                                str(db),
                                "--max-errors",
                                value,
                            ]
                        )
                    self.assertEqual(code, 1)
                    self.assertFalse(db.exists())

            with redirect_stderr(io.StringIO()):
                code = main(["audit-events", "--db", str(db)])
            self.assertEqual(code, 1)
            self.assertFalse(db.exists())


if __name__ == "__main__":
    unittest.main()
