"""Provider-neutral ingestion contract and deterministic local replay.

Replay is simulation/testing only. It is not a live market stream and makes no
real-time latency claim. The existing one-shot Frankfurter adapter is wrapped
without changing its network or normalization behavior.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterator, Literal, Protocol, Sequence

from .provider_frankfurter import (
    DEFAULT_QUOTES,
    PROVIDER_ID,
    FetchResult,
    fetch_rates,
)

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

REPLAY_PROVIDER_ID = "replay-local"
REPLAY_ENDPOINT = "replay://local-fixtures"
# Deterministic simulation metadata only; this is not a real receipt time.
REPLAY_RECEIVED_AT = "1970-01-01T00:00:00+00:00"


class IngestionError(ValueError):
    """Raised when an ingestion source or replay fixture is invalid."""


@dataclass(frozen=True)
class IngestionBatch:
    """One provider-neutral batch with exact payload provenance."""

    provider_id: str
    endpoint: str
    received_at: str
    payload: Any
    raw_payload_sha256: str
    raw_payload_bytes: int
    transport: Literal["http", "replay"]
    is_replay: bool
    sequence: int

    def __post_init__(self) -> None:
        if not isinstance(self.provider_id, str) or not self.provider_id.strip():
            raise IngestionError("provider_id must be a non-empty string")
        if not isinstance(self.endpoint, str) or not self.endpoint.strip():
            raise IngestionError("endpoint must be a non-empty string")
        if not isinstance(self.received_at, str) or not self.received_at.strip():
            raise IngestionError("received_at must be a non-empty string")
        if not isinstance(self.raw_payload_sha256, str):
            raise IngestionError("raw_payload_sha256 must be a string")
        digest = self.raw_payload_sha256.strip().lower()
        if not SHA256_RE.fullmatch(digest):
            raise IngestionError(
                "raw_payload_sha256 must be a 64-character hexadecimal SHA-256"
            )
        object.__setattr__(self, "raw_payload_sha256", digest)
        if (
            isinstance(self.raw_payload_bytes, bool)
            or not isinstance(self.raw_payload_bytes, int)
            or self.raw_payload_bytes < 0
        ):
            raise IngestionError(
                "raw_payload_bytes must be a non-negative integer"
            )
        if self.transport not in ("http", "replay"):
            raise IngestionError("transport must be 'http' or 'replay'")
        if not isinstance(self.is_replay, bool):
            raise IngestionError("is_replay must be boolean")
        if self.is_replay != (self.transport == "replay"):
            raise IngestionError("is_replay must match transport")
        if (
            isinstance(self.sequence, bool)
            or not isinstance(self.sequence, int)
            or self.sequence < 0
        ):
            raise IngestionError("sequence must be a non-negative integer")


class ProviderSource(Protocol):
    """Minimal provider-neutral source contract."""

    provider_id: str

    def iter_batches(self) -> Iterator[IngestionBatch]:
        """Yield batches in deterministic source order."""


@dataclass(frozen=True)
class _ReplayFixture:
    path: Path
    raw: bytes


def _within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


class ReplaySource:
    """Read explicit local JSON fixtures in deterministic order.

    Only paths that resolve beneath ``root`` are accepted. Path traversal and
    symlink escapes are rejected. The source hashes the exact fixture bytes
    before UTF-8 decoding or JSON parsing.
    """

    def __init__(
        self,
        root: str | Path,
        fixtures: Sequence[str | Path],
        *,
        provider_id: str = REPLAY_PROVIDER_ID,
        endpoint: str = REPLAY_ENDPOINT,
        received_at: str = REPLAY_RECEIVED_AT,
    ) -> None:
        if not fixtures:
            raise IngestionError("at least one replay fixture is required")

        try:
            root_path = Path(root).resolve(strict=True)
        except OSError as exc:
            raise IngestionError(f"replay root is not readable: {root}") from exc
        if not root_path.is_dir():
            raise IngestionError(f"replay root must be a directory: {root}")

        self.root = root_path
        self.provider_id = provider_id
        self.endpoint = endpoint
        self.received_at = received_at
        self._fixtures = tuple(self._load_fixtures(root_path, fixtures))

    def _load_fixtures(
        self, root: Path, fixtures: Sequence[str | Path]
    ) -> list[_ReplayFixture]:
        paths: list[Path] = []
        seen: set[Path] = set()

        for item in fixtures:
            candidate = Path(item)
            if not candidate.is_absolute():
                candidate = root / candidate
            try:
                resolved = candidate.resolve(strict=True)
            except OSError as exc:
                raise IngestionError(
                    f"replay fixture is not readable: {item}"
                ) from exc
            if not _within(resolved, root):
                raise IngestionError(
                    f"replay fixture escapes configured root: {item}"
                )

            if resolved.is_dir():
                children = sorted(resolved.glob("*.json"), key=lambda path: path.name)
                if not children:
                    raise IngestionError(
                        f"replay directory contains no JSON fixtures: {item}"
                    )
                for child in children:
                    try:
                        child_resolved = child.resolve(strict=True)
                    except OSError as exc:
                        raise IngestionError(
                            f"replay fixture is not readable: {child}"
                        ) from exc
                    if not _within(child_resolved, root):
                        raise IngestionError(
                            f"replay fixture escapes configured root: {child}"
                        )
                    if not child_resolved.is_file():
                        raise IngestionError(
                            f"replay fixture is not a file: {child}"
                        )
                    if child_resolved.suffix.lower() != ".json":
                        raise IngestionError(
                            f"replay fixture must be a JSON file: {child}"
                        )
                    if child_resolved in seen:
                        raise IngestionError(
                            f"duplicate replay fixture: {child_resolved}"
                        )
                    seen.add(child_resolved)
                    paths.append(child_resolved)
            elif resolved.is_file():
                if resolved.suffix.lower() != ".json":
                    raise IngestionError(
                        f"replay fixture must be a JSON file: {item}"
                    )
                if resolved in seen:
                    raise IngestionError(f"duplicate replay fixture: {resolved}")
                seen.add(resolved)
                paths.append(resolved)
            else:
                raise IngestionError(
                    f"replay fixture is not a file or directory: {item}"
                )

        loaded: list[_ReplayFixture] = []
        for path in paths:
            try:
                raw = path.read_bytes()
            except OSError as exc:
                raise IngestionError(
                    f"replay fixture is not readable: {path}"
                ) from exc
            try:
                json.loads(raw.decode("utf-8"), parse_float=Decimal)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise IngestionError(
                    f"replay fixture contains invalid JSON: {path}"
                ) from exc
            loaded.append(_ReplayFixture(path=path, raw=raw))
        return loaded

    def iter_batches(self) -> Iterator[IngestionBatch]:
        for sequence, fixture in enumerate(self._fixtures):
            payload = json.loads(fixture.raw.decode("utf-8"), parse_float=Decimal)
            yield IngestionBatch(
                provider_id=self.provider_id,
                endpoint=self.endpoint,
                received_at=self.received_at,
                payload=payload,
                raw_payload_sha256=hashlib.sha256(fixture.raw).hexdigest(),
                raw_payload_bytes=len(fixture.raw),
                transport="replay",
                is_replay=True,
                sequence=sequence,
            )


class FrankfurterSource:
    """Thin provider-neutral mapping of the existing one-shot FetchResult."""

    provider_id = PROVIDER_ID

    def __init__(
        self,
        base: str = "USD",
        quotes: Sequence[str] = DEFAULT_QUOTES,
        timeout: float = 15.0,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        self.base = base
        self.quotes = tuple(quotes)
        self.timeout = timeout
        self.opener = opener

    def iter_batches(self) -> Iterator[IngestionBatch]:
        result = fetch_rates(
            base=self.base,
            quotes=self.quotes,
            timeout=self.timeout,
            opener=self.opener,
        )
        yield _batch_from_fetch_result(result, sequence=0)


def _batch_from_fetch_result(
    result: FetchResult, *, sequence: int
) -> IngestionBatch:
    if result.raw_payload_sha256 is None or result.raw_payload_bytes is None:
        raise IngestionError(
            "FetchResult is missing exact raw payload provenance"
        )
    return IngestionBatch(
        provider_id=PROVIDER_ID,
        endpoint=result.endpoint,
        received_at=result.received_at,
        payload=result.payload,
        raw_payload_sha256=result.raw_payload_sha256,
        raw_payload_bytes=result.raw_payload_bytes,
        transport="http",
        is_replay=False,
        sequence=sequence,
    )
