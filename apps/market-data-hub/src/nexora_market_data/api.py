"""Read-only local HTTP API and static UI. Binds 127.0.0.1 only."""

from __future__ import annotations

import json
import sys
from datetime import date
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import (
    DISCLAIMER,
    NORMALIZATION_VERSION,
    OBSERVATION_SCHEMA_VERSION,
    __version__,
)
from .provider_frankfurter import PROVIDER_ID
from .quality import (
    DEFAULT_MAX_AGE_DAYS,
    QUALITY_LIMITATIONS,
    evaluate_rows,
    potential_weekday_gaps,
    quality_summary,
)
from .store import Store

APP_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WEB_DIR = APP_ROOT / "web"

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
}


class NexoraHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        store: Store,
        web_dir: Path = DEFAULT_WEB_DIR,
        as_of: str | None = None,
    ) -> None:
        if address[0] != "127.0.0.1":
            raise ValueError("server must bind to 127.0.0.1 only")
        self.store = store
        self.web_dir = Path(web_dir)
        self.as_of = as_of
        super().__init__(address, _Handler)


class _Handler(BaseHTTPRequestHandler):
    server: NexoraHTTPServer
    server_version = f"NEXORA-MarketData/{__version__}"
    sys_version = ""

    def do_GET(self) -> None:  # noqa: N802
        self._handle(head=False)

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle(head=True)

    def do_POST(self) -> None:  # noqa: N802
        self._send_json(
            HTTPStatus.METHOD_NOT_ALLOWED,
            {"error": "method_not_allowed", "detail": "read-only service"},
        )

    do_PUT = do_POST  # type: ignore[assignment]
    do_DELETE = do_POST  # type: ignore[assignment]
    do_PATCH = do_POST  # type: ignore[assignment]

    def _as_of(self) -> str:
        return self.server.as_of or date.today().isoformat()

    def _handle(self, head: bool) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/health":
            self._send_json(HTTPStatus.OK, self.server.store.health(), head=head)
            return

        if path == "/api/v1/fx/rates":
            query = parse_qs(parsed.query)
            try:
                limit = int(query.get("limit", ["100"])[0])
            except ValueError:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "invalid_limit", "detail": "limit must be an integer"},
                    head=head,
                )
                return
            as_of = self._as_of()
            rows = evaluate_rows(
                self.server.store.list_rates(limit), as_of, DEFAULT_MAX_AGE_DAYS
            )
            payload: dict[str, Any] = {
                "provider": PROVIDER_ID,
                "source_name": "Frankfurter v2 (blended daily reference)",
                "data_status": "DAILY_REFERENCE",
                "price_type": "MID",
                "executable": False,
                "disclaimer": DISCLAIMER,
                "as_of": as_of,
                "max_age_days": DEFAULT_MAX_AGE_DAYS,
                "quality_limitations": QUALITY_LIMITATIONS,
                "provenance": {
                    "raw_payload_sha256_scope": (
                        "exact provider HTTP response body bytes; "
                        "not re-serialized JSON"
                    ),
                    "normalization_version": NORMALIZATION_VERSION,
                    "schema_version": OBSERVATION_SCHEMA_VERSION,
                },
                "count": len(rows),
                "rates": rows,
            }
            self._send_json(HTTPStatus.OK, payload, head=head)
            return

        if path == "/api/v1/quality/summary":
            as_of = self._as_of()
            rows = self.server.store.list_rates(None)
            summary = quality_summary(rows, as_of, DEFAULT_MAX_AGE_DAYS)
            summary.update(
                {
                    "provider": PROVIDER_ID,
                    "data_status": "DAILY_REFERENCE",
                    "price_type": "MID",
                    "executable": False,
                    "disclaimer": DISCLAIMER,
                }
            )
            self._send_json(HTTPStatus.OK, summary, head=head)
            return

        if path == "/api/v1/providers/health":
            health = self.server.store.provider_health(PROVIDER_ID)
            health["data_status"] = "DAILY_REFERENCE"
            self._send_json(HTTPStatus.OK, health, head=head)
            return

        if path == "/api/v1/quality/gaps":
            query = parse_qs(parsed.query)
            try:
                limit = int(query.get("limit", ["100"])[0])
            except ValueError:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "invalid_limit", "detail": "limit must be an integer"},
                    head=head,
                )
                return
            rows = self.server.store.list_rates(None)
            gaps = potential_weekday_gaps(rows, max_gaps=limit)
            gaps.update(
                {
                    "provider": PROVIDER_ID,
                    "data_status": "DAILY_REFERENCE",
                    "disclaimer": DISCLAIMER,
                }
            )
            self._send_json(HTTPStatus.OK, gaps, head=head)
            return

        if path in STATIC_FILES:
            filename, content_type = STATIC_FILES[path]
            self._send_file(filename, content_type, head=head)
            return

        if path.startswith("/api/"):
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {"error": "not_found", "detail": "unknown endpoint"},
                head=head,
            )
            return

        self._send_bytes(
            HTTPStatus.NOT_FOUND,
            b"Not found\n",
            "text/plain; charset=utf-8",
            head=head,
        )

    def _send_file(self, filename: str, content_type: str, head: bool) -> None:
        target = (self.server.web_dir / filename).resolve()
        if not target.is_file() or self.server.web_dir.resolve() not in target.parents:
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {"error": "asset_missing", "detail": filename},
                head=head,
            )
            return
        self._send_bytes(HTTPStatus.OK, target.read_bytes(), content_type, head=head)

    def _send_json(self, status: HTTPStatus, payload: dict[str, Any], head: bool = False) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8", head=head)

    def _send_bytes(
        self,
        status: HTTPStatus,
        body: bytes,
        content_type: str,
        head: bool = False,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        )
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write(
            f"{self.address_string()} - [{self.log_date_time_string()}] {fmt % args}\n"
        )


def create_server(
    store: Store,
    host: str = "127.0.0.1",
    port: int = 8000,
    web_dir: Path = DEFAULT_WEB_DIR,
    as_of: str | None = None,
) -> NexoraHTTPServer:
    if host != "127.0.0.1":
        raise ValueError("host must be 127.0.0.1; public binding is not permitted")
    return NexoraHTTPServer((host, int(port)), store, web_dir, as_of=as_of)
