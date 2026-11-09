"""Strict normalization of Frankfurter v2 rows into NEXORA observations."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable

from . import (
    DATA_STATUS,
    EXECUTABLE,
    NORMALIZATION_VERSION,
    OBSERVATION_SCHEMA_VERSION,
    PRICE_TYPE,
)

CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

REQUIRED_FIELDS = ("date", "base", "quote", "rate")

PROVIDER_METADATA_PROVIDED = "PROVIDED"
PROVIDER_METADATA_NOT_PROVIDED = "NOT_PROVIDED_OR_PEGGED"


class NormalizationError(ValueError):
    """Raised when a provider payload violates the expected schema."""


@dataclass(frozen=True)
class ProviderContribution:
    """One provider record from Frankfurter's ``expand=providers`` array."""

    key: str
    date: str | None
    rate: str | None
    excluded: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "date": self.date,
            "rate": self.rate,
            "excluded": self.excluded,
        }


@dataclass(frozen=True)
class Observation:
    provider_id: str
    base: str
    quote: str
    observation_date: str
    rate: Decimal
    data_status: str
    price_type: str
    executable: bool
    source_name: str
    attribution: str
    provider_keys: tuple[str, ...]
    excluded_provider_keys: tuple[str, ...]
    provider_contributions: tuple[ProviderContribution, ...]
    provider_metadata_status: str
    received_at: str
    endpoint: str
    raw_json: str
    raw_payload_sha256: str | None
    raw_payload_bytes: int | None
    normalization_version: str
    schema_version: str


def _currency(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise NormalizationError(f"{field} must be a string")
    code = value.strip().upper()
    if not CURRENCY_RE.fullmatch(code):
        raise NormalizationError(f"{field} is not a 3-letter currency code: {value!r}")
    return code


def _observation_date(value: Any) -> str:
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        raise NormalizationError(f"date must be YYYY-MM-DD: {value!r}")
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError as exc:
        raise NormalizationError(f"invalid calendar date: {value!r}") from exc
    return value


def _as_of_date(value: str | None) -> Any:
    if value is None:
        return None
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        raise NormalizationError(f"as_of must be YYYY-MM-DD: {value!r}")
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise NormalizationError(f"invalid as_of date: {value!r}") from exc


def _rate(value: Any) -> Decimal:
    if isinstance(value, bool):
        raise NormalizationError("rate must be numeric, not boolean")
    try:
        if isinstance(value, Decimal):
            rate = value
        elif isinstance(value, (int, float)):
            rate = Decimal(str(value))
        elif isinstance(value, str):
            rate = Decimal(value.strip())
        else:
            raise NormalizationError(f"rate must be numeric: {value!r}")
    except (InvalidOperation, ValueError) as exc:
        raise NormalizationError(f"invalid rate: {value!r}") from exc
    if not rate.is_finite() or rate <= 0:
        raise NormalizationError(f"rate must be finite and positive: {value!r}")
    return rate


def _payload_sha256(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise NormalizationError("raw_payload_sha256 must be a string when supplied")
    digest = value.strip().lower()
    if not SHA256_RE.fullmatch(digest):
        raise NormalizationError(
            "raw_payload_sha256 must be a 64-character hexadecimal SHA-256"
        )
    return digest


def _payload_bytes(value: int | None) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise NormalizationError(
            "raw_payload_bytes must be a non-negative integer when supplied"
        )
    return value


def parse_provider_contributions(
    row: dict[str, Any],
) -> tuple[tuple[ProviderContribution, ...], str]:
    """Parse the v2 provider contribution array without losing metadata.

    Missing or null ``providers`` means the row may be pegged/synthesized and
    is marked ``NOT_PROVIDED_OR_PEGGED``. An empty array is treated the same
    way because it carries no attribution. Individual entries keep key, date,
    rate, and excluded so the blend/exclusion decision remains auditable.
    """
    if "providers" not in row or row.get("providers") is None:
        return (), PROVIDER_METADATA_NOT_PROVIDED
    providers = row["providers"]
    if not isinstance(providers, list):
        raise NormalizationError("providers must be a list when present")
    if not providers:
        return (), PROVIDER_METADATA_NOT_PROVIDED

    contributions: list[ProviderContribution] = []
    for index, item in enumerate(providers):
        if not isinstance(item, dict):
            raise NormalizationError(f"provider entry {index} must be an object")
        key = item.get("key")
        if not isinstance(key, str) or not key.strip():
            raise NormalizationError(f"provider entry {index} missing non-empty key")

        provider_date = item.get("date")
        if provider_date is not None:
            if not isinstance(provider_date, str) or not DATE_RE.fullmatch(provider_date):
                raise NormalizationError(
                    f"provider entry {index} date must be YYYY-MM-DD: {provider_date!r}"
                )
            try:
                datetime.strptime(provider_date, "%Y-%m-%d")
            except ValueError as exc:
                raise NormalizationError(
                    f"provider entry {index} has invalid date: {provider_date!r}"
                ) from exc

        provider_rate = item.get("rate")
        rate_text: str | None
        if provider_rate is None:
            rate_text = None
        else:
            rate_text = str(_rate(provider_rate))

        excluded = item.get("excluded", False)
        if not isinstance(excluded, bool):
            raise NormalizationError(
                f"provider entry {index} excluded must be boolean: {excluded!r}"
            )

        contributions.append(
            ProviderContribution(
                key=key.strip().upper(),
                date=provider_date,
                rate=rate_text,
                excluded=excluded,
            )
        )

    return tuple(contributions), PROVIDER_METADATA_PROVIDED


def _attribution(
    included_keys: tuple[str, ...],
    excluded_keys: tuple[str, ...],
    metadata_status: str,
) -> str:
    base = "Frankfurter blended daily reference rates"
    if included_keys:
        text = f"{base}; contributors: {', '.join(included_keys)}"
        if excluded_keys:
            text += f"; excluded: {', '.join(excluded_keys)}"
        return text
    if excluded_keys:
        return (
            f"{base}; all provided contributors excluded from blend: "
            f"{', '.join(excluded_keys)}"
        )
    if metadata_status == PROVIDER_METADATA_NOT_PROVIDED:
        return f"{base} (provider metadata not provided; possibly pegged/synthesized)"
    return f"{base} (provider attribution unavailable)"


def normalize_payload(
    payload: Any,
    received_at: str,
    endpoint: str,
    provider_id: str = "frankfurter-blended",
    source_name: str = "Frankfurter v2 (blended daily reference)",
    as_of: str | None = None,
    raw_payload_sha256: str | None = None,
    raw_payload_bytes: int | None = None,
) -> list[Observation]:
    """Validate every row and return observations.

    Rejects the whole payload on any invalid row so a partial feed never
    silently becomes authoritative. When ``as_of`` is supplied, an
    observation dated after it is rejected rather than stored as valid.
    ``raw_payload_sha256`` is copied from the exact provider response bytes;
    this function does not hash re-serialized JSON to manufacture one.
    """
    if not isinstance(payload, list) or not payload:
        raise NormalizationError("payload must be a non-empty JSON array")

    payload_sha256 = _payload_sha256(raw_payload_sha256)
    payload_bytes = _payload_bytes(raw_payload_bytes)
    as_of_date = _as_of_date(as_of)
    observations: list[Observation] = []
    seen: set[tuple[str, str, str]] = set()

    for index, row in enumerate(payload):
        if not isinstance(row, dict):
            raise NormalizationError(f"row {index} must be an object")
        missing = [field for field in REQUIRED_FIELDS if field not in row]
        if missing:
            raise NormalizationError(
                f"row {index} missing required field(s): {', '.join(missing)}"
            )

        base = _currency(row["base"], f"row {index} base")
        quote = _currency(row["quote"], f"row {index} quote")
        if base == quote:
            raise NormalizationError(f"row {index} base and quote are identical")
        observation_date = _observation_date(row["date"])
        if as_of_date is not None:
            observation_day = datetime.strptime(observation_date, "%Y-%m-%d").date()
            if observation_day > as_of_date:
                raise NormalizationError(
                    f"row {index} observation date is in the future: "
                    f"{observation_date} > {as_of}"
                )
        rate = _rate(row["rate"])
        contributions, metadata_status = parse_provider_contributions(row)
        included_keys = tuple(
            sorted({item.key for item in contributions if not item.excluded})
        )
        excluded_keys = tuple(
            sorted({item.key for item in contributions if item.excluded})
        )

        dedup = (base, quote, observation_date)
        if dedup in seen:
            raise NormalizationError(
                f"duplicate pair/date in payload: {base}/{quote} {observation_date}"
            )
        seen.add(dedup)

        observations.append(
            Observation(
                provider_id=provider_id,
                base=base,
                quote=quote,
                observation_date=observation_date,
                rate=rate,
                data_status=DATA_STATUS,
                price_type=PRICE_TYPE,
                executable=EXECUTABLE,
                source_name=source_name,
                attribution=_attribution(
                    included_keys, excluded_keys, metadata_status
                ),
                provider_keys=included_keys,
                excluded_provider_keys=excluded_keys,
                provider_contributions=contributions,
                provider_metadata_status=metadata_status,
                received_at=received_at,
                endpoint=endpoint,
                raw_json=json.dumps(row, default=str, sort_keys=True),
                raw_payload_sha256=payload_sha256,
                raw_payload_bytes=payload_bytes,
                normalization_version=NORMALIZATION_VERSION,
                schema_version=OBSERVATION_SCHEMA_VERSION,
            )
        )

    return observations
