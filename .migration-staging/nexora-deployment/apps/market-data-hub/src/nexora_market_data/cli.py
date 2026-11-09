"""Command-line entry points: fetch, list, serve, replay-local, audit-events."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from . import (
    DISCLAIMER,
    NORMALIZATION_VERSION,
    OBSERVATION_SCHEMA_VERSION,
    __version__,
)
from .api import create_server
from .event_quality import MAX_AUDIT_ERRORS
from .ingestion import ReplaySource
from .normalizer import NormalizationError, normalize_payload
from .provider_frankfurter import (
    DEFAULT_QUOTES,
    PROVIDER_ID,
    SOURCE_NAME,
    ProviderError,
    build_url,
    fetch_rates,
)
from .replay_journal import journal_replay
from .store import Store

APP_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = APP_ROOT / "var" / "nexora_market_data.db"
DEFAULT_CAPTURE = APP_ROOT / "var" / "last-fetch.json"
DEFAULT_REPLAY_FIXTURES = APP_ROOT / "tests" / "fixtures" / "replay"


def _require_scratch_db(value: str) -> Path:
    """Resolve a scratch DB path and reject the application var/ directory."""
    try:
        resolved = Path(value).expanduser().resolve(strict=False)
    except OSError as exc:
        raise ValueError("database path could not be resolved") from exc

    var_root = (APP_ROOT / "var").resolve(strict=False)
    production = DEFAULT_DB.resolve(strict=False)
    normalized = os.path.normcase(str(resolved))
    normalized_var = os.path.normcase(str(var_root))
    normalized_production = os.path.normcase(str(production))
    try:
        under_var = (
            os.path.commonpath([normalized, normalized_var]) == normalized_var
        )
    except ValueError:
        under_var = False

    if normalized == normalized_production or under_var:
        raise ValueError(
            "refusing to use the application var/ database directory; "
            "use a separate scratch --db path"
        )
    if resolved.is_dir():
        raise ValueError("database path must be a file, not a directory")
    return resolved


def _replay_fixture_root(value: str) -> Path:
    try:
        resolved = Path(value).expanduser().resolve(strict=True)
    except OSError as exc:
        raise ValueError("replay fixtures directory is not readable") from exc
    if not resolved.is_dir():
        raise ValueError("replay fixtures path must be a directory")
    return resolved



def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _duration_ms(started: float) -> int:
    return max(0, int((time.monotonic() - started) * 1000))


def _parse_quotes(value: str) -> list[str]:
    quotes = [part.strip().upper() for part in value.split(",") if part.strip()]
    if not quotes:
        raise argparse.ArgumentTypeError("at least one quote currency is required")
    return quotes


def _record_attempt_safe(
    db: str,
    *,
    provider_id: str,
    endpoint: str,
    attempted_at: str,
    completed_at: str,
    duration_ms: int,
    http_status: int | None,
    outcome: str,
    rows_fetched: int = 0,
    error_class: str | None = None,
    error_message: str | None = None,
) -> None:
    """Best-effort attempt record; never masks the original fetch error."""
    try:
        with Store(db) as store:
            store.record_attempt(
                provider_id=provider_id,
                endpoint=endpoint,
                attempted_at=attempted_at,
                completed_at=completed_at,
                duration_ms=duration_ms,
                http_status=http_status,
                outcome=outcome,
                rows_fetched=rows_fetched,
                error_class=error_class,
                error_message=error_message,
            )
    except (sqlite3.Error, OSError, ValueError):
        pass


def _write_capture(path: Path, result: Any, observations: list[Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "provider": PROVIDER_ID,
        "source_name": SOURCE_NAME,
        "endpoint": result.endpoint,
        "received_at": result.received_at,
        "http_status": result.http_status,
        "data_status": "DAILY_REFERENCE",
        "price_type": "MID",
        "executable": False,
        "disclaimer": DISCLAIMER,
        "raw_payload_sha256": result.raw_payload_sha256,
        "raw_payload_bytes": result.raw_payload_bytes,
        "raw_payload_sha256_scope": (
            "exact provider HTTP response body bytes; not re-serialized JSON"
        ),
        "normalization_version": NORMALIZATION_VERSION,
        "schema_version": OBSERVATION_SCHEMA_VERSION,
        "observations": [
            {
                "base": obs.base,
                "quote": obs.quote,
                "observation_date": obs.observation_date,
                "rate": str(obs.rate),
                "data_status": obs.data_status,
                "price_type": obs.price_type,
                "executable": obs.executable,
                "source_name": obs.source_name,
                "attribution": obs.attribution,
                "provider_keys": list(obs.provider_keys),
                "excluded_provider_keys": list(obs.excluded_provider_keys),
                "provider_contributions": [
                    item.as_dict() for item in obs.provider_contributions
                ],
                "provider_metadata_status": obs.provider_metadata_status,
                "raw_payload_sha256": obs.raw_payload_sha256,
                "raw_payload_bytes": obs.raw_payload_bytes,
                "normalization_version": obs.normalization_version,
                "schema_version": obs.schema_version,
            }
            for obs in observations
        ],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _cmd_fetch(args: argparse.Namespace) -> int:
    attempted_at = _utc_now()
    started = time.monotonic()
    endpoint = ""
    observations: list[Any] = []
    try:
        endpoint = build_url(args.base, args.quotes)
        result = fetch_rates(
            base=args.base,
            quotes=args.quotes,
            timeout=args.timeout,
        )
        as_of = datetime.now(timezone.utc).date().isoformat()
        observations = normalize_payload(
            result.payload,
            received_at=result.received_at,
            endpoint=result.endpoint,
            provider_id=PROVIDER_ID,
            source_name=SOURCE_NAME,
            as_of=as_of,
            raw_payload_sha256=result.raw_payload_sha256,
            raw_payload_bytes=result.raw_payload_bytes,
        )
        with Store(args.db) as store:
            counts = store.upsert(observations)
            store.record_attempt(
                provider_id=PROVIDER_ID,
                endpoint=result.endpoint,
                attempted_at=attempted_at,
                completed_at=_utc_now(),
                duration_ms=_duration_ms(started),
                http_status=result.http_status,
                outcome="OK",
                rows_fetched=len(observations),
            )
            health = store.health()
        if args.capture:
            _write_capture(Path(args.capture), result, observations)
        summary = {
            "status": "ok",
            "provider": PROVIDER_ID,
            "source_name": SOURCE_NAME,
            "endpoint": result.endpoint,
            "http_status": result.http_status,
            "received_at": result.received_at,
            "data_status": "DAILY_REFERENCE",
            "price_type": "MID",
            "executable": False,
            "disclaimer": DISCLAIMER,
            "raw_payload_sha256": result.raw_payload_sha256,
            "raw_payload_bytes": result.raw_payload_bytes,
            "raw_payload_sha256_scope": (
                "exact provider HTTP response body bytes; not re-serialized JSON"
            ),
            "normalization_version": NORMALIZATION_VERSION,
            "schema_version": OBSERVATION_SCHEMA_VERSION,
            "as_of": as_of,
            "rows_fetched": len(observations),
            "inserted": counts["inserted"],
            "updated": counts["updated"],
            "stored_observations": health["stored_observations"],
            "capture": str(args.capture) if args.capture else None,
            "database": str(args.db),
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    except (ProviderError, NormalizationError, sqlite3.Error, OSError, ValueError) as exc:
        _record_attempt_safe(
            args.db,
            provider_id=PROVIDER_ID,
            endpoint=endpoint,
            attempted_at=attempted_at,
            completed_at=_utc_now(),
            duration_ms=_duration_ms(started),
            http_status=getattr(exc, "http_status", None),
            outcome="ERROR",
            rows_fetched=len(observations),
            error_class=type(exc).__name__,
            error_message=str(exc),
        )
        print(f"fetch failed: {exc}", file=sys.stderr)
        return 1


def _cmd_list(args: argparse.Namespace) -> int:
    try:
        with Store(args.db) as store:
            rows = store.list_rates(args.limit)
            health = store.health()
            provider_health = store.provider_health(PROVIDER_ID)
        print(
            json.dumps(
                {
                    "health": health,
                    "provider_health": provider_health,
                    "count": len(rows),
                    "rates": rows,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except (sqlite3.Error, OSError) as exc:
        print(f"list failed: {exc}", file=sys.stderr)
        return 1


def _cmd_serve(args: argparse.Namespace) -> int:
    try:
        with Store(args.db) as store:
            server = create_server(store, host="127.0.0.1", port=args.port)
            print(
                f"NEXORA market-data hub {__version__} at http://127.0.0.1:{server.server_port}/",
                flush=True,
            )
            print(DISCLAIMER, flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                print("stopping", flush=True)
            finally:
                server.server_close()
        return 0
    except (sqlite3.Error, OSError, ValueError) as exc:
        print(f"serve failed: {exc}", file=sys.stderr)
        return 1


def _print_command_error(command: str, exc: Exception) -> None:
    """Print a sanitized failure without SQL values, payloads, or rates."""
    print(f"{command} failed ({type(exc).__name__})", file=sys.stderr)


def _cmd_replay_local(args: argparse.Namespace) -> int:
    store: Store | None = None
    try:
        db = _require_scratch_db(args.db)
        fixtures = _replay_fixture_root(args.fixtures)
        source = ReplaySource(fixtures, ["."])
        store = Store(db)
        counts = journal_replay(source, store)
        print(json.dumps(counts, separators=(",", ":"), sort_keys=True))
        return 0
    except (OSError, ValueError, sqlite3.Error) as exc:
        _print_command_error("replay-local", exc)
        return 1
    finally:
        if store is not None:
            store.close()


def _cmd_audit_events(args: argparse.Namespace) -> int:
    store: Store | None = None
    try:
        if not 1 <= args.max_errors <= MAX_AUDIT_ERRORS:
            raise ValueError("max_errors out of range")
        db = _require_scratch_db(args.db)
        if not db.is_file():
            raise ValueError("audit database does not exist")
        store = Store(db, read_only=True)
        result = store.audit_events(max_errors=args.max_errors)
        print(json.dumps(result, separators=(",", ":"), sort_keys=True))
        return 0
    except (OSError, ValueError, sqlite3.Error) as exc:
        _print_command_error("audit-events", exc)
        return 1
    finally:
        if store is not None:
            store.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nexora-market-data",
        description="Read-only daily FX reference rates (Frankfurter v2).",
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    fetch = sub.add_parser("fetch", help="fetch once, validate, and upsert")
    fetch.add_argument("--base", default="USD")
    fetch.add_argument(
        "--quotes",
        default=",".join(DEFAULT_QUOTES),
        type=_parse_quotes,
        help="comma-separated quote currencies",
    )
    fetch.add_argument("--db", default=str(DEFAULT_DB))
    fetch.add_argument("--capture", default=str(DEFAULT_CAPTURE))
    fetch.add_argument("--timeout", type=float, default=15.0)
    fetch.set_defaults(func=_cmd_fetch)

    list_cmd = sub.add_parser("list", help="print stored observations")
    list_cmd.add_argument("--db", default=str(DEFAULT_DB))
    list_cmd.add_argument("--limit", type=int, default=100)
    list_cmd.set_defaults(func=_cmd_list)

    serve = sub.add_parser("serve", help="serve the read-only local UI/API")
    serve.add_argument("--db", default=str(DEFAULT_DB))
    serve.add_argument("--port", type=int, default=8000)
    serve.set_defaults(func=_cmd_serve)

    replay_local = sub.add_parser(
        "replay-local",
        help="journal synthetic replay fixtures into a scratch database",
    )
    replay_local.add_argument(
        "--db",
        required=True,
        help="explicit scratch SQLite path; var/ is rejected",
    )
    replay_local.add_argument(
        "--fixtures",
        default=str(DEFAULT_REPLAY_FIXTURES),
        help="directory of synthetic replay JSON fixtures",
    )
    replay_local.set_defaults(func=_cmd_replay_local)

    audit_events = sub.add_parser(
        "audit-events",
        help="read-only integrity audit of replay events in a scratch database",
    )
    audit_events.add_argument(
        "--db",
        required=True,
        help="explicit scratch SQLite path; var/ is rejected",
    )
    audit_events.add_argument("--max-errors", type=int, default=100)
    audit_events.set_defaults(func=_cmd_audit_events)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))
