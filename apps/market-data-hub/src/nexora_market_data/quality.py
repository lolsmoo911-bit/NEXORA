"""Deterministic data-quality evaluation and potential-gap reporting."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Iterable

FRESH = "FRESH"
STALE = "STALE"
FUTURE_DATE = "FUTURE_DATE"
UNKNOWN = "UNKNOWN"

QUALITY_STATUSES = (FRESH, STALE, FUTURE_DATE, UNKNOWN)

# Provisional: allows ordinary weekends and a three-day weekend without
# claiming a universal market calendar. Provider holidays can still create
# false STALE flags. D-004 remains open.
DEFAULT_MAX_AGE_DAYS = 4

QUALITY_LIMITATIONS = (
    "Freshness uses each row's observation date, not received_at. "
    "The provisional calendar-day threshold allows weekends but has no "
    "provider holiday calendar, so holidays can produce false STALE flags. "
    "Outlier detection is deferred until comparable provider series or a "
    "historical baseline exists."
)

GAP_LIMITATIONS = (
    "POTENTIAL_WEEKDAY_GAP only skips Saturday/Sunday. It has no bank-holiday "
    "calendar, so holidays can appear as false gaps. Missing rates are not "
    "fabricated or interpolated."
)


def _parse_date(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def evaluate_observation(
    observation_date: Any,
    as_of: str,
    max_age_days: int = DEFAULT_MAX_AGE_DAYS,
) -> dict[str, Any]:
    """Classify one observation date as FRESH/STALE/FUTURE_DATE/UNKNOWN."""
    if not isinstance(max_age_days, int) or isinstance(max_age_days, bool):
        raise ValueError("max_age_days must be an integer")
    if max_age_days < 0:
        raise ValueError("max_age_days must be non-negative")

    as_of_day = _parse_date(as_of)
    observation_day = _parse_date(observation_date)
    if as_of_day is None:
        return {
            "quality_status": UNKNOWN,
            "age_days": None,
            "quality_reason": f"invalid as_of date: {as_of!r}",
        }
    if observation_day is None:
        return {
            "quality_status": UNKNOWN,
            "age_days": None,
            "quality_reason": f"invalid observation date: {observation_date!r}",
        }

    age_days = (as_of_day - observation_day).days
    if age_days < 0:
        return {
            "quality_status": FUTURE_DATE,
            "age_days": age_days,
            "quality_reason": "observation date is after as_of",
        }
    if age_days <= max_age_days:
        return {
            "quality_status": FRESH,
            "age_days": age_days,
            "quality_reason": f"within {max_age_days} calendar days",
        }
    return {
        "quality_status": STALE,
        "age_days": age_days,
        "quality_reason": f"older than {max_age_days} calendar days",
    }


def evaluate_rows(
    rows: Iterable[dict[str, Any]],
    as_of: str,
    max_age_days: int = DEFAULT_MAX_AGE_DAYS,
) -> list[dict[str, Any]]:
    """Return rows enriched with quality_status/age_days/quality_reason."""
    enriched: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item.update(evaluate_observation(row.get("observation_date"), as_of, max_age_days))
        enriched.append(item)
    return enriched


def quality_summary(
    rows: Iterable[dict[str, Any]],
    as_of: str,
    max_age_days: int = DEFAULT_MAX_AGE_DAYS,
) -> dict[str, Any]:
    """Count quality statuses and report latest observation/receipt dates."""
    counts = {status: 0 for status in QUALITY_STATUSES}
    latest_observation: date | None = None
    latest_observation_text: str | None = None
    latest_received_at: str | None = None
    total = 0

    for row in rows:
        total += 1
        result = evaluate_observation(
            row.get("observation_date"), as_of, max_age_days
        )
        counts[result["quality_status"]] += 1

        observation_day = _parse_date(row.get("observation_date"))
        if observation_day is not None:
            if latest_observation is None or observation_day > latest_observation:
                latest_observation = observation_day
                latest_observation_text = observation_day.isoformat()

        received_at = row.get("received_at")
        if isinstance(received_at, str):
            if latest_received_at is None or received_at > latest_received_at:
                latest_received_at = received_at

    return {
        "as_of": as_of,
        "max_age_days": max_age_days,
        "total": total,
        "fresh": counts[FRESH],
        "stale": counts[STALE],
        "future_date": counts[FUTURE_DATE],
        "unknown": counts[UNKNOWN],
        "latest_observation_date": latest_observation_text,
        "latest_received_at": latest_received_at,
        "status_taxonomy": list(QUALITY_STATUSES),
        "limitations": QUALITY_LIMITATIONS,
    }


def potential_weekday_gaps(
    rows: Iterable[dict[str, Any]],
    max_gaps: int = 100,
) -> dict[str, Any]:
    """Find missing weekdays between stored observations per pair.

    Only consecutive stored dates for the same base/quote are compared.
    Weekends are skipped; holidays are not known and can cause false
    positives. A single observation cannot establish a gap.
    """
    if not isinstance(max_gaps, int) or isinstance(max_gaps, bool):
        raise ValueError("max_gaps must be an integer")
    max_gaps = max(1, min(max_gaps, 500))

    grouped: dict[tuple[str, str], set[date]] = {}
    for row in rows:
        base = row.get("base")
        quote = row.get("quote")
        observation_day = _parse_date(row.get("observation_date"))
        if not isinstance(base, str) or not isinstance(quote, str):
            continue
        if observation_day is None:
            continue
        grouped.setdefault((base.upper(), quote.upper()), set()).add(observation_day)

    gaps: list[dict[str, str]] = []
    truncated = False
    for (base, quote), days in sorted(grouped.items()):
        ordered = sorted(days)
        if len(ordered) < 2:
            continue
        for previous, current in zip(ordered, ordered[1:]):
            cursor = previous + timedelta(days=1)
            while cursor < current:
                if cursor.weekday() < 5:
                    if len(gaps) >= max_gaps:
                        truncated = True
                        break
                    gaps.append(
                        {
                            "base": base,
                            "quote": quote,
                            "missing_date": cursor.isoformat(),
                            "status": "POTENTIAL_WEEKDAY_GAP",
                        }
                    )
                cursor += timedelta(days=1)
            if truncated:
                break
        if truncated:
            break

    return {
        "status": "POTENTIAL_WEEKDAY_GAP",
        "count": len(gaps),
        "truncated": truncated,
        "gaps": gaps,
        "limitations": GAP_LIMITATIONS,
    }
