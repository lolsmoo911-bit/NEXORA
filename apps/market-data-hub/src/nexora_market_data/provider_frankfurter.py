"""Frankfurter v2 provider adapter (public, keyless, blended daily rates)."""

from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Callable, Sequence

BASE_URL = "https://api.frankfurter.dev"
PROVIDER_ID = "frankfurter-blended"
SOURCE_NAME = "Frankfurter v2 (blended daily reference)"
DEFAULT_QUOTES: tuple[str, ...] = ("EUR", "GBP", "JPY", "CHF")
USER_AGENT = "NEXORA-market-data-mvp/0.1 (local research; read-only)"


class ProviderError(RuntimeError):
    """Raised when the provider request or JSON decoding fails."""

    def __init__(self, message: str, http_status: int | None = None) -> None:
        super().__init__(message)
        self.http_status = http_status


@dataclass(frozen=True)
class FetchResult:
    payload: Any
    endpoint: str
    received_at: str
    http_status: int
    raw_payload_sha256: str | None = None
    raw_payload_bytes: int | None = None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def build_url(base: str, quotes: Sequence[str]) -> str:
    base_norm = str(base).strip().upper()
    quote_norm = [str(q).strip().upper() for q in quotes if str(q).strip()]
    if not base_norm or not quote_norm:
        raise ValueError("base and at least one quote are required")
    params = {
        "base": base_norm,
        "quotes": ",".join(quote_norm),
        "expand": "providers",
    }
    return f"{BASE_URL}/v2/rates?{urllib.parse.urlencode(params)}"


def fetch_rates(
    base: str = "USD",
    quotes: Sequence[str] = DEFAULT_QUOTES,
    timeout: float = 15.0,
    opener: Callable[..., Any] | None = None,
) -> FetchResult:
    """Perform one bounded GET and decode JSON with Decimal numbers.

    ``raw_payload_sha256`` covers the exact response body bytes read from the
    provider before UTF-8 decoding or JSON parsing. It is not a hash of
    re-serialized JSON. ``opener`` is injectable for tests; production uses
    ``urllib.request.urlopen``.
    """
    endpoint = build_url(base, quotes)
    request = urllib.request.Request(
        endpoint,
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        method="GET",
    )
    open_fn = opener or urllib.request.urlopen
    try:
        with open_fn(request, timeout=timeout) as response:
            status = int(getattr(response, "status", 200))
            raw = response.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ProviderError(f"provider request failed: {exc}") from exc

    if status != 200:
        raise ProviderError(
            f"provider returned HTTP {status}", http_status=status
        )

    try:
        payload = json.loads(raw.decode("utf-8"), parse_float=Decimal)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProviderError(f"provider returned invalid JSON: {exc}") from exc

    return FetchResult(
        payload=payload,
        endpoint=endpoint,
        received_at=_utc_now(),
        http_status=status,
        raw_payload_sha256=hashlib.sha256(raw).hexdigest(),
        raw_payload_bytes=len(raw),
    )
