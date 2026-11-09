from __future__ import annotations

import argparse
import asyncio
import csv
import ipaddress
import json
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
TEST_URL = "https://api.ipify.org"
META_MARKER = "\n__PROXY_GRABBER_META__"
MAX_SOURCE_BYTES = 5 * 1024 * 1024

@dataclass(frozen=True)
class Source:
    name: str
    url: str
    default_protocol: str

SOURCES = [
    Source("ProxyScrape HTTP", "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/protocols/http/data.txt", "http"),
    Source("ProxyScrape HTTPS-capable HTTP", "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/protocols/https/data.txt", "http"),
    Source("ProxyScrape SOCKS5", "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/protocols/socks5/data.txt", "socks5"),
    Source("HProxy HTTP", "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/http.txt", "http"),
    Source("HProxy HTTPS-capable HTTP", "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/https.txt", "http"),
    Source("HProxy SOCKS5", "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/socks5.txt", "socks5"),
    Source("monosans HTTP", "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", "http"),
    Source("monosans SOCKS5", "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt", "socks5"),
]

@dataclass
class Candidate:
    protocol: str
    host: str
    port: int
    sources: list[str] = field(default_factory=list)

    @property
    def key(self) -> tuple[str, str, int]:
        return (self.protocol, self.host, self.port)

    @property
    def uri(self) -> str:
        scheme = "socks5h" if self.protocol == "socks5" else self.protocol
        return f"{scheme}://{self.host}:{self.port}"

def parse_candidate(line: str, default_protocol: str) -> tuple[str, str, int] | None:
    text = line.strip().lstrip("\ufeff")
    if not text or text.startswith(("#", ";", "//")):
        return None
    scheme_match = re.match(r"^([a-zA-Z0-9]+)://(.+)$", text)
    protocol = default_protocol.lower()
    address = text
    if scheme_match:
        raw_scheme, address = scheme_match.groups()
        raw_scheme = raw_scheme.lower()
        if raw_scheme in {"socks5", "socks5h"}:
            protocol = "socks5"
        elif raw_scheme in {"http", "https"}:
            protocol = raw_scheme
        else:
            return None
    if "@" in address or "/" in address or "?" in address or "#" in address:
        return None
    if address.startswith("[") and "]:" in address:
        host, port_text = address[1:].split("]:", 1)
    else:
        if address.count(":") != 1:
            return None
        host, port_text = address.rsplit(":", 1)
    try:
        ip = ipaddress.ip_address(host)
        port = int(port_text)
    except ValueError:
        return None
    if ip.version != 4 or not ip.is_global or not 1 <= port <= 65535:
        return None
    if protocol not in {"http", "https", "socks5"}:
        return None
    return protocol, str(ip), port

def fetch_source(source: Source, timeout: float = 14.0) -> tuple[list[tuple[str, str, int]], str | None]:
    request = urllib.request.Request(source.url, headers={"User-Agent": "Nexora-ProxyGrabber/1.0"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(MAX_SOURCE_BYTES + 1)
        if len(raw) > MAX_SOURCE_BYTES:
            return [], "source exceeded 5 MiB safety limit"
        body = raw.decode("utf-8", errors="replace")
        found = []
        for line in body.splitlines():
            parsed = parse_candidate(line, source.default_protocol)
            if parsed:
                found.append(parsed)
        return found, None
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        return [], f"{type(exc).__name__}: {exc}"

def curl_path() -> str:
    path = shutil.which("curl.exe") or shutil.which("curl")
    if not path:
        raise RuntimeError("curl.exe was not found. Add Windows curl to PATH.")
    return path

async def check_one(semaphore: asyncio.Semaphore, curl: str, candidate: Candidate, timeout: float) -> dict:
    async with semaphore:
        args = [
            curl, "--noproxy", "",
            "--connect-timeout", str(min(4.0, timeout)),
            "--max-time", str(timeout),
            "--silent", "--show-error",
            "--output", "-",
            "--write-out", META_MARKER + "%{http_code}|%{time_total}|%{ssl_verify_result}",
            TEST_URL,
        ]
        if candidate.protocol == "socks5":
            args[1:1] = ["--socks5-hostname", f"{candidate.host}:{candidate.port}"]
        else:
            proxy_scheme = "https" if candidate.protocol == "https" else "http"
            args[1:1] = ["--proxy", f"{proxy_scheme}://{candidate.host}:{candidate.port}"]
        started = time.perf_counter()
        try:
            proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout + 2.0)
            output = stdout.decode("utf-8", errors="replace")
            body, marker, meta = output.partition(META_MARKER)
            parts = meta.split("|") if marker else []
            http_status = int(parts[0]) if parts and parts[0].isdigit() else 0
            reported_time = float(parts[1]) if len(parts) >= 2 else time.perf_counter() - started
            ssl_verify = int(parts[2]) if len(parts) >= 3 and parts[2].isdigit() else None
            try:
                egress_ip = str(ipaddress.ip_address(body.strip()))
            except ValueError:
                egress_ip = ""
            ok = proc.returncode == 0 and http_status == 200 and bool(egress_ip)
            status = "HTTPS_OK" if ok else (f"HTTP_{http_status}" if http_status else f"CURL_{proc.returncode}")
            return {
                "protocol": candidate.protocol, "host": candidate.host, "port": candidate.port,
                "uri": candidate.uri, "sources": sorted(set(candidate.sources)),
                "ok": ok, "status": status, "http_status": http_status, "egress_ip": egress_ip,
                "latency_ms": round(reported_time * 1000, 1), "ssl_verify_result": ssl_verify,
                "checked_at": datetime.now(timezone.utc).isoformat(),
            }
        except asyncio.TimeoutError:
            if "proc" in locals() and proc.returncode is None:
                proc.kill()
                await proc.wait()
            return {
                "protocol": candidate.protocol, "host": candidate.host, "port": candidate.port,
                "uri": candidate.uri, "sources": sorted(set(candidate.sources)), "ok": False,
                "status": "TIMEOUT", "http_status": 0, "egress_ip": "",
                "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                "ssl_verify_result": None, "checked_at": datetime.now(timezone.utc).isoformat(),
            }
        except OSError as exc:
            return {
                "protocol": candidate.protocol, "host": candidate.host, "port": candidate.port,
                "uri": candidate.uri, "sources": sorted(set(candidate.sources)), "ok": False,
                "status": f"ERROR_{type(exc).__name__}", "http_status": 0, "egress_ip": "",
                "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                "ssl_verify_result": None, "checked_at": datetime.now(timezone.utc).isoformat(),
            }

def write_results(rows: list[dict]) -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    working = sorted((row for row in rows if row["ok"]), key=lambda row: row["latency_ms"])
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    json_path = RESULTS / f"proxy-check-{stamp}.json"
    txt_path = RESULTS / f"working-proxies-{stamp}.txt"
    csv_path = RESULTS / f"proxy-check-{stamp}.csv"
    json_path.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    txt_path.write_text("".join(row["uri"] + "\n" for row in working), encoding="utf-8")
    fields = ["protocol", "host", "port", "uri", "ok", "status", "http_status", "egress_ip", "latency_ms", "ssl_verify_result", "sources", "checked_at"]
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            item = dict(row)
            item["sources"] = ";".join(item["sources"])
            writer.writerow({key: item.get(key) for key in fields})
    summary = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "total_checked": len(rows), "working": len(working), "failed": len(rows) - len(working),
        "by_protocol": {p: sum(1 for row in working if row["protocol"] == p) for p in ("http", "https", "socks5")},
        "json": str(json_path), "txt": str(txt_path), "csv": str(csv_path),
    }
    (RESULTS / "latest-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print("\n=== RESULTS ===")
    print(f"Checked: {summary['total_checked']} | HTTPS working: {summary['working']} | Failed: {summary['failed']}")
    print("Working by protocol: " + ", ".join(f"{k}={v}" for k, v in summary["by_protocol"].items()))
    print(f"Saved JSON: {json_path}\nSaved TXT : {txt_path}\nSaved CSV : {csv_path}")
    print("\nFastest passing candidates (connectivity check only):")
    for row in working[:12]:
        print(f"  {row['latency_ms']:>7.1f} ms  {row['protocol']:<5}  {row['host']}:{row['port']}  exit={row['egress_ip']}")

async def main_async(args: argparse.Namespace) -> int:
    curl = curl_path()
    print(f"[proxy-grabber] Fetching {len(SOURCES)} public source lists...")
    candidates: dict[tuple[str, str, int], Candidate] = {}
    for source in SOURCES:
        entries, error = await asyncio.to_thread(fetch_source, source)
        if error:
            print(f"  WARN {source.name}: {error}")
            continue
        accepted = 0
        for protocol, host, port in entries:
            if args.protocol == "http" and protocol not in {"http", "https"}:
                continue
            if args.protocol == "socks5" and protocol != "socks5":
                continue
            key = (protocol, host, port)
            if key not in candidates:
                candidates[key] = Candidate(protocol, host, port)
            if source.name not in candidates[key].sources:
                candidates[key].sources.append(source.name)
            accepted += 1
        print(f"  OK   {source.name}: {accepted} entries")
    unique = sorted(candidates.values(), key=lambda c: (c.protocol, c.host, c.port))
    if args.limit_per_source > 0:
        selected: dict[tuple[str, str, int], Candidate] = {}
        per_source: dict[str, int] = {}
        for item in unique:
            eligible = [s for s in item.sources if per_source.get(s, 0) < args.limit_per_source]
            if eligible:
                selected[item.key] = item
                for name in eligible:
                    per_source[name] = per_source.get(name, 0) + 1
        unique = list(selected.values())
    print(f"[proxy-grabber] Unique public candidates queued: {len(unique)}")
    if not unique:
        print("No candidates fetched. Check network connectivity or source availability.")
        return 2
    semaphore = asyncio.Semaphore(args.concurrency)
    tasks = [check_one(semaphore, curl, item, args.timeout) for item in unique]
    rows = []
    for index, future in enumerate(asyncio.as_completed(tasks), start=1):
        rows.append(await future)
        if index % 25 == 0 or index == len(tasks):
            print(f"  checked {index}/{len(tasks)}")
    write_results(rows)
    return 0

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect and check public HTTP CONNECT / SOCKS5 endpoints.")
    parser.add_argument("--protocol", choices=("all", "http", "socks5"), default="all")
    parser.add_argument("--limit-per-source", type=int, default=100)
    parser.add_argument("--concurrency", type=int, default=20)
    parser.add_argument("--timeout", type=float, default=6.0)
    args = parser.parse_args()
    if args.limit_per_source < 0:
        parser.error("--limit-per-source must be >= 0")
    if not 1 <= args.concurrency <= 40:
        parser.error("--concurrency must be between 1 and 40")
    if not 3 <= args.timeout <= 15:
        parser.error("--timeout must be between 3 and 15 seconds")
    return args

if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main_async(parse_args())))
    except KeyboardInterrupt:
        print("\nInterrupted by user.", file=sys.stderr)
        raise SystemExit(130)

