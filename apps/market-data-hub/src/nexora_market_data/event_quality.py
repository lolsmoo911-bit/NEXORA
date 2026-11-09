"""Read-only integrity audit for the replay-only event journal.

The audit never writes, repairs, migrates, or deletes records. It validates the
stored replay envelope and its payload using the same replay markers as
``replay_journal`` and returns compact error codes only. No rate values or raw
payload text are returned.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable

from .events import (
    IDENTIFIER_RE,
    LOCAL_REPLAY_SEQUENCE_KIND,
    REPLAY_EVENT_ID_PREFIX,
    REPLAY_RECEIVED_TIME_KIND,
    SHA256_RE,
    SYNTHETIC_EVENT_TIME_KIND,
)

DEFAULT_MAX_ERRORS = 100
MAX_AUDIT_ERRORS = 1000

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
INSTRUMENT_RE = re.compile(r"^FX:[A-Z]{3}/[A-Z]{3}$")
UTC_TIMESTAMP_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$"
)


def _reject_constant(value: str) -> None:
    raise ValueError(f"invalid JSON numeric constant: {value}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _get(row: Any, name: str) -> Any:
    try:
        return row[name]
    except (KeyError, IndexError, TypeError):
        return None


def _dedupe(errors: list[str]) -> list[str]:
    return list(dict.fromkeys(errors))


def _valid_hash(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    return SHA256_RE.fullmatch(value.strip().lower()) is not None


def _valid_bytes(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and value >= 0
    )


def _valid_rate(value: Any) -> bool:
    """Accept only finite, positive Decimal text; never a JSON number/float."""
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        parsed = Decimal(value.strip())
    except (InvalidOperation, ValueError):
        return False
    return parsed.is_finite() and parsed > 0


def _is_utc_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not UTC_TIMESTAMP_RE.fullmatch(value):
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return True


def _date_ordinal(value: Any) -> int | None:
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        return None
    try:
        return date.fromisoformat(value).toordinal()
    except ValueError:
        return None


def audit_event_row(row: Any) -> list[str]:
    """Return field error codes for one stored event row. Read-only."""
    errors: list[str] = []

    payload_json = _get(row, "payload_json")
    payload: dict[str, Any] | None = None
    if not isinstance(payload_json, str):
        errors.append("INVALID_PAYLOAD_JSON")
    else:
        try:
            parsed = json.loads(
                payload_json,
                parse_float=Decimal,
                parse_constant=_reject_constant,
                object_pairs_hook=_unique_object,
            )
        except (json.JSONDecodeError, TypeError, ValueError):
            errors.append("INVALID_PAYLOAD_JSON")
        else:
            if isinstance(parsed, dict):
                payload = parsed
            else:
                errors.append("PAYLOAD_NOT_OBJECT")

    is_replay = _get(row, "is_replay")
    if not (
        is_replay is True
        or (
            isinstance(is_replay, int)
            and not isinstance(is_replay, bool)
            and is_replay == 1
        )
    ):
        errors.append("ROW_NOT_REPLAY")
    if _get(row, "sequence_kind") != LOCAL_REPLAY_SEQUENCE_KIND:
        errors.append("SEQUENCE_KIND_MISMATCH")

    if not _is_utc_timestamp(_get(row, "event_timestamp")):
        errors.append("INVALID_EVENT_TIMESTAMP")
    if not _is_utc_timestamp(_get(row, "received_timestamp")):
        errors.append("INVALID_RECEIVED_TIMESTAMP")

    row_instrument = _get(row, "instrument_id")
    if not isinstance(row_instrument, str) or not INSTRUMENT_RE.fullmatch(
        row_instrument
    ):
        errors.append("INSTRUMENT_FORMAT_INVALID")

    row_provider = _get(row, "provider_id")
    if not isinstance(row_provider, str) or not IDENTIFIER_RE.fullmatch(
        row_provider.strip()
    ):
        errors.append("INVALID_PROVIDER_ID")

    if payload is None:
        return _dedupe(errors)

    if payload.get("is_replay") is not True:
        errors.append("PAYLOAD_NOT_REPLAY")
    if payload.get("sequence_kind") != LOCAL_REPLAY_SEQUENCE_KIND:
        errors.append("PAYLOAD_SEQUENCE_KIND_MISMATCH")
    if payload.get("provider_id") != row_provider:
        errors.append("PROVIDER_ID_MISMATCH")
    if payload.get("instrument_id") != row_instrument:
        errors.append("INSTRUMENT_ID_MISMATCH")

    if payload.get("event_time_kind") != SYNTHETIC_EVENT_TIME_KIND:
        errors.append("EVENT_TIME_KIND_MISMATCH")
    if payload.get("received_time_kind") != REPLAY_RECEIVED_TIME_KIND:
        errors.append("RECEIVED_TIME_KIND_MISMATCH")

    payload_received_timestamp = payload.get("received_timestamp")
    row_received_timestamp = _get(row, "received_timestamp")
    if not _is_utc_timestamp(payload_received_timestamp):
        errors.append("INVALID_PAYLOAD_RECEIVED_TIMESTAMP")
    elif payload_received_timestamp != row_received_timestamp:
        errors.append("RECEIVED_TIMESTAMP_MISMATCH")

    row_hash = _get(row, "source_payload_sha256")
    payload_hash = payload.get("raw_payload_sha256")
    if not (_valid_hash(row_hash) and _valid_hash(payload_hash)):
        errors.append("INVALID_SOURCE_HASH")
    elif row_hash != payload_hash:
        errors.append("SOURCE_HASH_MISMATCH")

    row_bytes = _get(row, "source_payload_bytes")
    payload_bytes = payload.get("raw_payload_bytes")
    if not (_valid_bytes(row_bytes) and _valid_bytes(payload_bytes)):
        errors.append("INVALID_SOURCE_BYTES")
    elif row_bytes != payload_bytes:
        errors.append("SOURCE_BYTES_MISMATCH")

    if not _valid_rate(payload.get("rate")):
        errors.append("INVALID_RATE")

    base = payload.get("base")
    quote = payload.get("quote")
    expected_instrument: str | None = None
    if isinstance(base, str) and isinstance(quote, str):
        candidate = f"FX:{base}/{quote}"
        if INSTRUMENT_RE.fullmatch(candidate):
            expected_instrument = candidate
        else:
            errors.append("INSTRUMENT_FORMAT_MISMATCH")
    else:
        errors.append("INSTRUMENT_FORMAT_MISMATCH")

    if expected_instrument is not None:
        if payload.get("instrument_id") != expected_instrument:
            errors.append("INSTRUMENT_FORMAT_MISMATCH")
        if row_instrument != expected_instrument:
            errors.append("INSTRUMENT_FORMAT_MISMATCH")

    observation_date = payload.get("observation_date")
    ordinal = _date_ordinal(observation_date)
    if ordinal is None:
        errors.append("INVALID_OBSERVATION_DATE")
    else:
        expected_timestamp = f"{observation_date}T00:00:00.000000Z"
        if _get(row, "event_timestamp") != expected_timestamp:
            errors.append("EVENT_TIMESTAMP_MISMATCH")
        if _get(row, "sequence") != ordinal:
            errors.append("SEQUENCE_MISMATCH")
        if expected_instrument is not None:
            expected_event_id = (
                f"{REPLAY_EVENT_ID_PREFIX}:{expected_instrument}:"
                f"{observation_date}"
            )
            if _get(row, "event_id") != expected_event_id:
                errors.append("EVENT_ID_MISMATCH")
            if (
                "event_id" in payload
                and payload.get("event_id") != expected_event_id
            ):
                errors.append("EVENT_ID_MISMATCH")

    return _dedupe(errors)


def _safe_row_id(row: Any) -> int | None:
    """Return a validated row identifier, never echoing untrusted values."""
    value = _get(row, "event_row_id")
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def audit_event_rows(
    rows: Iterable[Any], *, max_errors: int = DEFAULT_MAX_ERRORS
) -> dict[str, Any]:
    """Audit stored replay rows without modifying them.

    ``max_errors`` bounds the returned error list, not the scan. Counts cover
    every scanned row. Results contain only validated non-negative integer
    ``event_row_id`` values and field error codes; no rate values, raw payload
    text, or event IDs are returned.
    """
    if (
        isinstance(max_errors, bool)
        or not isinstance(max_errors, int)
        or not 1 <= max_errors <= MAX_AUDIT_ERRORS
    ):
        raise ValueError(
            f"max_errors must be an integer between 1 and {MAX_AUDIT_ERRORS}"
        )

    scanned = 0
    valid = 0
    invalid = 0
    errors: list[dict[str, Any]] = []

    for row in rows:
        scanned += 1
        row_errors = audit_event_row(row)
        if row_errors:
            invalid += 1
            if len(errors) < max_errors:
                errors.append(
                    {
                        "event_row_id": _safe_row_id(row),
                        "errors": row_errors,
                    }
                )
        else:
            valid += 1

    return {
        "scanned": scanned,
        "valid": valid,
        "invalid": invalid,
        "errors": errors,
        "errors_truncated": invalid > len(errors),
        "max_errors": max_errors,
    }
