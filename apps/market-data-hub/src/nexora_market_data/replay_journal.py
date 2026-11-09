"""Journal deterministic synthetic replay batches as replay-only events.

This module is a local engineering simulation boundary. It is not a live
market stream, scheduler, or trading path, and it makes no real-time or
latency claim. Only batches explicitly marked as replay are accepted; a
live/HTTP batch is rejected before anything is written.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from typing import Any

from .events import (
    LOCAL_REPLAY_SEQUENCE_KIND,
    REPLAY_EVENT_ID_PREFIX,
    REPLAY_RECEIVED_TIME_KIND,
    SYNTHETIC_EVENT_TIME_KIND,
    MarketDataEvent,
)
from .ingestion import IngestionBatch, ProviderSource
from .normalizer import Observation, normalize_payload
from .store import Store

EVENT_TIME_KIND = SYNTHETIC_EVENT_TIME_KIND
RECEIVED_TIME_KIND = REPLAY_RECEIVED_TIME_KIND


class ReplayJournalError(ValueError):
    """Raised when a source is not an accepted deterministic replay source."""


def _canonical_utc_timestamp(value: str) -> str:
    """Normalize the deterministic replay receipt time to canonical UTC text."""
    if not isinstance(value, str) or not value.strip():
        raise ReplayJournalError("replay receipt timestamp is missing")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ReplayJournalError("replay receipt timestamp is invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ReplayJournalError("replay receipt timestamp must include a timezone")
    return (
        parsed.astimezone(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def instrument_id(observation: Observation) -> str:
    """Stable instrument identifier: ``FX:{BASE}/{QUOTE}``."""
    return f"FX:{observation.base}/{observation.quote}"


def event_id(observation: Observation) -> str:
    """Canonical replay identity without a source hash.

    Including the source hash would make a changed payload look like a new
    event. The canonical identity is replay provider + instrument + date, so a
    changed rate or source hash for that identity must conflict instead.
    """
    return (
        f"{REPLAY_EVENT_ID_PREFIX}:{instrument_id(observation)}:"
        f"{observation.observation_date}"
    )


def sequence(observation: Observation) -> int:
    """Stable local date-ordinal sequence, not a provider-issued sequence."""
    return date.fromisoformat(observation.observation_date).toordinal()


def event_timestamp(observation: Observation) -> str:
    """Synthetic date-only midnight UTC, explicitly not an observed time."""
    return f"{observation.observation_date}T00:00:00Z"


def event_payload(observation: Observation) -> dict[str, Any]:
    """Build a Decimal-preserving payload with clear replay/provenance markers."""
    return {
        "is_replay": True,
        "sequence_kind": LOCAL_REPLAY_SEQUENCE_KIND,
        "event_time_kind": EVENT_TIME_KIND,
        "received_time_kind": RECEIVED_TIME_KIND,
        "provider_id": observation.provider_id,
        "instrument_id": instrument_id(observation),
        "observation_date": observation.observation_date,
        "base": observation.base,
        "quote": observation.quote,
        # Rate text is preserved exactly; it is never converted to a float.
        "rate": str(observation.rate),
        "data_status": observation.data_status,
        "price_type": observation.price_type,
        "executable": observation.executable,
        "source_name": observation.source_name,
        "attribution": observation.attribution,
        "provider_keys": list(observation.provider_keys),
        "excluded_provider_keys": list(observation.excluded_provider_keys),
        "provider_metadata_status": observation.provider_metadata_status,
        "endpoint": observation.endpoint,
        "raw_payload_sha256": observation.raw_payload_sha256,
        "raw_payload_bytes": observation.raw_payload_bytes,
        "normalization_version": observation.normalization_version,
        "schema_version": observation.schema_version,
        "raw_record_json": observation.raw_json,
    }


def observation_to_event(
    observation: Observation, batch: IngestionBatch
) -> MarketDataEvent:
    """Convert one normalized observation into a replay-only journal event."""
    if observation.raw_payload_sha256 is None or observation.raw_payload_bytes is None:
        raise ReplayJournalError(
            "replay observation is missing exact raw payload provenance"
        )
    received_at = _canonical_utc_timestamp(batch.received_at)
    payload = event_payload(observation)
    payload["received_timestamp"] = received_at
    return MarketDataEvent(
        provider_id=observation.provider_id,
        instrument_id=instrument_id(observation),
        event_id=event_id(observation),
        sequence=sequence(observation),
        sequence_kind=LOCAL_REPLAY_SEQUENCE_KIND,
        event_timestamp=event_timestamp(observation),
        received_timestamp=received_at,
        payload_json=json.dumps(
            payload,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ),
        source_payload_sha256=observation.raw_payload_sha256,
        source_payload_bytes=observation.raw_payload_bytes,
        is_replay=True,
    )


def journal_replay(source: ProviderSource, store: Store) -> dict[str, int]:
    """Normalize and journal every batch from a deterministic replay source.

    All batches are validated as replay-only before the first write, so a
    non-replay batch cannot leave a partially journaled fixture set.
    """
    batches: list[IngestionBatch] = []
    for batch in source.iter_batches():
        if not isinstance(batch, IngestionBatch):
            raise ReplayJournalError("source must yield IngestionBatch values")
        if batch.is_replay is not True or batch.transport != "replay":
            raise ReplayJournalError(
                "event journal accepts replay batches only; refusing "
                f"transport={batch.transport!r}, is_replay={batch.is_replay!r}"
            )
        batches.append(batch)

    events: list[MarketDataEvent] = []
    for batch in batches:
        observations = normalize_payload(
            batch.payload,
            received_at=batch.received_at,
            endpoint=batch.endpoint,
            provider_id=batch.provider_id,
            raw_payload_sha256=batch.raw_payload_sha256,
            raw_payload_bytes=batch.raw_payload_bytes,
        )
        events.extend(
            observation_to_event(observation, batch)
            for observation in observations
        )

    counts = store.append_events(events)
    return {
        "batches_read": len(batches),
        "observations_journaled": len(events),
        "inserted": counts["inserted"],
        "duplicates": counts["duplicates"],
    }
