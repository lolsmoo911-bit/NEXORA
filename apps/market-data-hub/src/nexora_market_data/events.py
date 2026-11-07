"""Immutable event envelope for the provisional local replay journal.

The first implementation accepts replay events only. It is an engineering
simulation boundary, not a live provider stream or a canonical asset schema.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

LOCAL_REPLAY_SEQUENCE_KIND = "LOCAL_REPLAY_ORDER"
SYNTHETIC_EVENT_TIME_KIND = "SYNTHETIC_OBSERVATION_DATE_MIDNIGHT_UTC"
REPLAY_RECEIVED_TIME_KIND = "REPLAY_SIMULATION_TIME"
REPLAY_EVENT_ID_PREFIX = "replay"


class MarketDataEventError(ValueError):
    """Raised when a market-data event envelope is invalid."""


class MarketDataEventConflict(RuntimeError):
    """Raised when an event ID or sequence is reused for different content."""


def _identifier(value: Any, field: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER_RE.fullmatch(value.strip()):
        raise MarketDataEventError(f"{field} must be a valid non-empty identifier")
    return value.strip()


def _utc_timestamp(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise MarketDataEventError(f"{field} must be a timezone-aware ISO-8601 string")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise MarketDataEventError(f"{field} must be a valid ISO-8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise MarketDataEventError(f"{field} must include a timezone offset")
    return (
        parsed.astimezone(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
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


@dataclass(frozen=True)
class MarketDataEvent:
    """A replay-only, append-only event with local replay sequence and provenance.

    The payload is retained as validated JSON text. Decimal-aware parsing is
    used for validation so numeric JSON tokens are not first converted to
    binary floating-point values.
    """

    provider_id: str
    instrument_id: str
    event_id: str
    sequence: int
    event_timestamp: str
    received_timestamp: str
    payload_json: str
    source_payload_sha256: str
    source_payload_bytes: int
    is_replay: bool = True
    sequence_kind: str = LOCAL_REPLAY_SEQUENCE_KIND

    def __post_init__(self) -> None:
        object.__setattr__(self, "provider_id", _identifier(self.provider_id, "provider_id"))
        object.__setattr__(
            self, "instrument_id", _identifier(self.instrument_id, "instrument_id")
        )
        object.__setattr__(self, "event_id", _identifier(self.event_id, "event_id"))

        if (
            isinstance(self.sequence, bool)
            or not isinstance(self.sequence, int)
            or self.sequence < 0
        ):
            raise MarketDataEventError("sequence must be a non-negative integer")

        object.__setattr__(
            self, "event_timestamp", _utc_timestamp(self.event_timestamp, "event_timestamp")
        )
        object.__setattr__(
            self,
            "received_timestamp",
            _utc_timestamp(self.received_timestamp, "received_timestamp"),
        )

        if not isinstance(self.payload_json, str):
            raise MarketDataEventError("payload_json must be a JSON object string")
        try:
            payload = json.loads(
                self.payload_json,
                parse_float=Decimal,
                parse_constant=_reject_constant,
                object_pairs_hook=_unique_object,
            )
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            raise MarketDataEventError("payload_json must contain valid JSON") from exc
        if not isinstance(payload, dict):
            raise MarketDataEventError("payload_json must contain a JSON object")

        if not isinstance(self.source_payload_sha256, str):
            raise MarketDataEventError("source_payload_sha256 must be a string")
        digest = self.source_payload_sha256.strip().lower()
        if not SHA256_RE.fullmatch(digest):
            raise MarketDataEventError(
                "source_payload_sha256 must be a 64-character SHA-256 hex digest"
            )
        object.__setattr__(self, "source_payload_sha256", digest)

        if (
            isinstance(self.source_payload_bytes, bool)
            or not isinstance(self.source_payload_bytes, int)
            or self.source_payload_bytes < 0
        ):
            raise MarketDataEventError(
                "source_payload_bytes must be a non-negative integer"
            )

        if self.is_replay is not True:
            raise MarketDataEventError(
                "this event journal currently accepts replay events only"
            )

        if self.sequence_kind != LOCAL_REPLAY_SEQUENCE_KIND:
            raise MarketDataEventError(
                f"sequence_kind must be {LOCAL_REPLAY_SEQUENCE_KIND}"
            )
