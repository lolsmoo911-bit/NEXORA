#!/usr/bin/env python3
"""One-time, end-to-end encrypted text handoff for a local OpenCode host.

The HTTP server binds only to 127.0.0.1. The browser encodes pasted text as
UTF-8, encrypts it with AES-256-GCM, and wraps the AES key with the recipient
RSA-OAEP public key. Only the encrypted envelope is persisted by the server.
The receive path keeps decrypted text in memory, optionally hands it to an
in-process consumer, and wipes the mutable buffer without writing or printing it.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

BASE = Path(__file__).resolve().parent
WEB = BASE / "web"
VAR = BASE / "var"
KEYS = VAR / "keys"
STATE = VAR / "state"
INBOX = VAR / "inbox"
MAX_BYTES = 16 * 1024
DEFAULT_TTL = 600
AAD = b"NEXORA-SFH-v1"
ENVELOPE_KEYS = {"v", "iv", "wrappedKey", "ciphertext"}


class HandoffError(RuntimeError):
    pass


def _windows_identity() -> str:
    try:
        p = subprocess.run(["whoami"], capture_output=True, text=True, timeout=5)
        value = p.stdout.strip()
        if p.returncode == 0 and value:
            return value
    except Exception:
        pass
    return os.environ.get("USERNAME", "")


def _restrict_acl(path: Path, directory: bool) -> None:
    os.chmod(path, 0o700 if directory else 0o600)
    if os.name == "nt":
        identity = _windows_identity()
        if not identity:
            raise HandoffError("Cannot determine Windows identity for private-file ACL")
        grant = f"{identity}:(OI)(CI)F" if directory else f"{identity}:F"
        try:
            result = subprocess.run(
                ["icacls", str(path), "/inheritance:r", "/grant:r", grant],
                capture_output=True, text=True, timeout=10,
            )
        except Exception as exc:
            raise HandoffError("Could not apply Windows ACL to private data") from exc
        if result.returncode != 0:
            raise HandoffError("Could not apply Windows ACL to private data")


def secure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    _restrict_acl(path, True)


def secure_write(path: Path, data: bytes, overwrite: bool = False) -> None:
    secure_dir(path.parent)
    flags = os.O_WRONLY | os.O_CREAT
    flags |= os.O_TRUNC if overwrite else os.O_EXCL
    fd = os.open(str(path), flags, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass
        raise
    _restrict_acl(path, False)


def read_json(path: Path, max_bytes: int = 65536) -> dict:
    raw = path.read_bytes()
    if len(raw) > max_bytes:
        raise HandoffError("State file exceeds size limit")
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise HandoffError("Invalid state file")
    return value


def json_bytes(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def b64d(value: str, max_decoded: int) -> bytes:
    if not isinstance(value, str) or len(value) > max_decoded * 2:
        raise HandoffError("Invalid encrypted envelope")
    try:
        data = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise HandoffError("Invalid encrypted envelope") from exc
    if len(data) > max_decoded:
        raise HandoffError("Encrypted envelope exceeds size limit")
    return data


def public_key_fingerprint(public_key) -> str:
    der = public_key.public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return hashlib.sha256(der).hexdigest()


def generate_keypair(key_dir: Path = KEYS, key_size: int = 3072) -> tuple[Path, Path]:
    if key_size != 3072:
        raise HandoffError("Production key size must be 3072 bits")
    secure_dir(key_dir)
    private_path = key_dir / "recipient-private.pem"
    public_path = key_dir / "recipient-public.pem"
    if private_path.exists() or public_path.exists():
        raise HandoffError("Key files already exist; refusing to overwrite")
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=key_size)
    private_bytes = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public_bytes = private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    secure_write(private_path, private_bytes)
    secure_write(public_path, public_bytes)
    return private_path, public_path


def load_private(path: Path):
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, rsa.RSAPrivateKey) or key.key_size != 3072:
        raise HandoffError("Recipient private key must be RSA-3072")
    return key


def load_public(path: Path):
    key = serialization.load_pem_public_key(path.read_bytes())
    if not isinstance(key, rsa.RSAPublicKey) or key.key_size != 3072:
        raise HandoffError("Recipient public key must be RSA-3072")
    return key


def validate_envelope(envelope: dict, max_bytes: int = MAX_BYTES, rsa_bytes: int = 384) -> dict:
    if not isinstance(envelope, dict) or set(envelope) != ENVELOPE_KEYS or envelope.get("v") != 1:
        raise HandoffError("Invalid encrypted envelope")
    iv = b64d(envelope["iv"], 12)
    wrapped = b64d(envelope["wrappedKey"], rsa_bytes)
    ciphertext = b64d(envelope["ciphertext"], max_bytes + 16)
    if len(iv) != 12 or len(wrapped) != rsa_bytes or len(ciphertext) < 16:
        raise HandoffError("Invalid encrypted envelope")
    if len(ciphertext) > max_bytes + 16:
        raise HandoffError("File exceeds size limit")
    return {"v": 1, "iv": envelope["iv"], "wrappedKey": envelope["wrappedKey"], "ciphertext": envelope["ciphertext"]}


def encrypt_for_test(public_key, plaintext: bytes) -> dict:
    if len(plaintext) > MAX_BYTES:
        raise HandoffError("File exceeds size limit")
    aes_key = AESGCM.generate_key(bit_length=256)
    iv = os.urandom(12)
    ciphertext = AESGCM(aes_key).encrypt(iv, plaintext, AAD)
    wrapped = public_key.encrypt(
        aes_key,
        padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()),
                     algorithm=hashes.SHA256(), label=AAD),
    )
    return {
        "v": 1,
        "iv": base64.b64encode(iv).decode("ascii"),
        "wrappedKey": base64.b64encode(wrapped).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
    }


def decrypt_envelope(private_key, envelope: dict, max_bytes: int = MAX_BYTES) -> bytearray:
    envelope = validate_envelope(envelope, max_bytes, private_key.key_size // 8)
    iv = b64d(envelope["iv"], 12)
    wrapped = b64d(envelope["wrappedKey"], private_key.key_size // 8)
    ciphertext = b64d(envelope["ciphertext"], max_bytes + 16)
    try:
        aes_key = private_key.decrypt(
            wrapped,
            padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()),
                         algorithm=hashes.SHA256(), label=AAD),
        )
        if len(aes_key) != 32:
            raise HandoffError("Invalid encrypted key")
        plaintext = AESGCM(aes_key).decrypt(iv, ciphertext, AAD)
    except HandoffError:
        raise
    except Exception as exc:
        raise HandoffError("Encrypted text failed authentication") from exc
    if len(plaintext) > max_bytes:
        raise HandoffError("Decrypted text exceeds size limit")
    return bytearray(plaintext)


def _safe_public_base(value: str | None, local_url: str) -> str:
    if not value:
        return local_url
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise HandoffError("Public base URL must be a bare HTTPS origin")
    return value.rstrip("/")


class HandoffApp:
    def __init__(self, public_key_path: Path, state_dir: Path, inbox_dir: Path,
                 ttl_seconds: int = DEFAULT_TTL, max_bytes: int = MAX_BYTES,
                 public_base_url: str | None = None):
        if not 60 <= ttl_seconds <= 600:
            raise HandoffError("TTL must be between 60 and 600 seconds")
        if not 1 <= max_bytes <= MAX_BYTES:
            raise HandoffError("Maximum file size must be between 1 byte and 16 KiB")
        self.public_key = load_public(public_key_path)
        self.fingerprint = public_key_fingerprint(self.public_key)
        self.state_dir = state_dir
        self.inbox_dir = inbox_dir
        secure_dir(state_dir)
        secure_dir(inbox_dir)
        if any(inbox_dir.iterdir()):
            raise HandoffError("Encrypted inbox is not empty; run cleanup first")
        self.ttl_seconds = ttl_seconds
        self.max_bytes = max_bytes
        self.upload_token = secrets.token_urlsafe(32)
        self.claim_token = secrets.token_urlsafe(32)
        self.expires_at = time.time() + ttl_seconds
        self.uploaded = False
        self.claimed = False
        self.pending_path: Path | None = None
        self.lock = threading.Lock()
        self.httpd: ThreadingHTTPServer | None = None
        self.timer: threading.Timer | None = None
        self.local_base_url = ""
        self.public_base_url = ""
        self.upload_url_path = state_dir / "upload-url.txt"
        self.claim_token_path = state_dir / "claim-token.txt"
        self.server_info_path = state_dir / "server.json"
        secure_write(self.claim_token_path, (self.claim_token + "\n").encode("ascii"))
        self.public_base_requested = public_base_url

    def status_data(self) -> dict:
        return {
            "v": 1,
            "status": "uploaded" if self.uploaded else "waiting",
            "expiresAt": int(self.expires_at),
            "maxBytes": self.max_bytes,
            "fingerprint": self.fingerprint,
        }

    def start(self, port: int = 8765) -> None:
        app = self
        class Handler(BaseHTTPRequestHandler):
            server_version = "NEXORA-SFH"
            sys_version = ""

            def log_message(self, _format, *args):
                return

            def send(self, code: int, body: bytes, content_type: str):
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Pragma", "no-cache")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("X-Frame-Options", "DENY")
                self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            def do_HEAD(self):
                self.do_GET()

            def do_GET(self):
                if self.path == "/":
                    body = (WEB / "index.html").read_bytes()
                    self.send(200, body, "text/html; charset=utf-8")
                elif self.path == "/app.js":
                    body = (WEB / "app.js").read_bytes()
                    self.send(200, body, "application/javascript; charset=utf-8")
                elif self.path == "/style.css":
                    body = (WEB / "style.css").read_bytes()
                    self.send(200, body, "text/css; charset=utf-8")
                elif self.path == "/api/public-key":
                    body = app.public_key.public_bytes(
                        serialization.Encoding.PEM,
                        serialization.PublicFormat.SubjectPublicKeyInfo,
                    )
                    self.send(200, body, "application/x-pem-file")
                elif self.path == "/api/status":
                    self.send(200, json_bytes(app.status_data()), "application/json")
                else:
                    self.send(404, b'{"error":"not_found"}', "application/json")

            def do_POST(self):
                if self.path == "/api/upload":
                    self._upload()
                elif self.path == "/api/claim":
                    self._claim()
                elif self.path == "/api/ack":
                    self._ack()
                else:
                    self.send(404, b'{"error":"not_found"}', "application/json")

            def _token_ok(self, header: str, expected: str) -> bool:
                supplied = self.headers.get(header, "")
                return bool(supplied) and hmac.compare_digest(supplied.encode(), expected.encode())

            def _upload(self):
                if not self._token_ok("X-Upload-Token", app.upload_token):
                    self.send(401, b'{"error":"unauthorized"}', "application/json")
                    return
                with app.lock:
                    if time.time() > app.expires_at:
                        app.cleanup()
                        self.send(410, b'{"error":"expired"}', "application/json")
                        return
                    if app.uploaded:
                        self.send(409, b'{"error":"already_uploaded"}', "application/json")
                        return
                    raw_length = self.headers.get("Content-Length", "")
                    if not raw_length.isdigit():
                        self.send(411, b'{"error":"length_required"}', "application/json")
                        return
                    length = int(raw_length)
                    max_request = app.max_bytes * 2 + 4096
                    if length < 1 or length > max_request:
                        self.send(413, b'{"error":"too_large"}', "application/json")
                        return
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        self.send(400, b'{"error":"invalid_body"}', "application/json")
                        return
                    try:
                        envelope = json.loads(raw.decode("utf-8"))
                        validate_envelope(envelope, app.max_bytes, app.public_key.key_size // 8)
                    except Exception:
                        self.send(400, b'{"error":"invalid_envelope"}', "application/json")
                        return
                    name = secrets.token_hex(16) + ".ciphertext.json"
                    path = app.inbox_dir / name
                    secure_write(path, json_bytes(envelope))
                    app.pending_path = path
                    app.uploaded = True
                    meta = {
                        "v": 1,
                        "pending": name,
                        "expiresAt": int(app.expires_at),
                        "fingerprint": app.fingerprint,
                        "ciphertextBytes": len(b64d(envelope["ciphertext"], app.max_bytes + 16)),
                    }
                    secure_write(app.state_dir / "pending.json", json_bytes(meta), overwrite=True)
                    app._write_server_info()
                    self.send(201, b'{"ok":true}', "application/json")

            def _claim(self):
                if not self._token_ok("X-Claim-Token", app.claim_token):
                    self.send(401, b'{"error":"unauthorized"}', "application/json")
                    return
                with app.lock:
                    if time.time() > app.expires_at:
                        app.cleanup()
                        self.send(410, b'{"error":"expired"}', "application/json")
                        return
                    if not app.uploaded or app.pending_path is None:
                        self.send(404, b'{"error":"not_ready"}', "application/json")
                        return
                    if app.claimed:
                        self.send(409, b'{"error":"already_claimed"}', "application/json")
                        return
                    try:
                        envelope = read_json(app.pending_path, app.max_bytes * 2 + 4096)
                    except Exception:
                        self.send(410, b'{"error":"missing"}', "application/json")
                        return
                    app.claimed = True
                    self.send(200, json_bytes(envelope), "application/json")

            def _ack(self):
                if not self._token_ok("X-Claim-Token", app.claim_token):
                    self.send(401, b'{"error":"unauthorized"}', "application/json")
                    return
                with app.lock:
                    if not app.claimed:
                        self.send(409, b'{"error":"not_claimed"}', "application/json")
                        return
                    app.cleanup()
                    self.send(200, b'{"ok":true}', "application/json")
                    threading.Thread(target=app.httpd.shutdown, daemon=True).start()

        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.httpd.daemon_threads = True
        actual_port = self.httpd.server_address[1]
        self.local_base_url = f"http://127.0.0.1:{actual_port}"
        self.public_base_url = _safe_public_base(self.public_base_requested, self.local_base_url)
        self._write_server_info()
        upload_url = f"{self.public_base_url}/#u={self.upload_token}"
        secure_write(self.upload_url_path, (upload_url + "\n").encode("utf-8"), overwrite=True)
        self.timer = threading.Timer(self.ttl_seconds, self._expire)
        self.timer.daemon = True
        self.timer.start()

    def _write_server_info(self) -> None:
        info = {
            "v": 1,
            "localBaseUrl": self.local_base_url,
            "expiresAt": int(self.expires_at),
            "maxBytes": self.max_bytes,
            "fingerprint": self.fingerprint,
            "uploaded": self.uploaded,
        }
        secure_write(self.server_info_path, json_bytes(info), overwrite=True)

    def _expire(self):
        self.cleanup()
        if self.httpd:
            self.httpd.shutdown()

    def cleanup(self):
        for path in (self.inbox_dir, self.state_dir):
            if path.exists():
                for child in list(path.iterdir()):
                    if child.is_file():
                        child.unlink(missing_ok=True)
        self.uploaded = False
        self.claimed = False
        self.pending_path = None

    def serve_forever(self):
        if not self.httpd:
            raise HandoffError("Server has not been started")
        try:
            self.httpd.serve_forever(poll_interval=0.2)
        finally:
            if self.timer:
                self.timer.cancel()
            self.httpd.server_close()


def _post_json(base_url: str, endpoint: str, token_header: str, token: str, payload: dict | None = None) -> tuple[int, bytes]:
    data = None if payload is None else json_bytes(payload)
    request = urllib.request.Request(
        base_url + endpoint,
        data=data,
        method="POST",
        headers={token_header: token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, response.read(65536)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(2048)


def _wipe_buffer(buffer: bytearray) -> None:
    for index in range(len(buffer)):
        buffer[index] = 0
    buffer.clear()


def receive(
    state_dir: Path,
    private_key_path: Path,
    consumer: Callable[[memoryview], None] | None = None,
    quiet: bool = False,
) -> dict:
    info = read_json(state_dir / "server.json")
    base_url = info.get("localBaseUrl", "")
    parsed = urlsplit(base_url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.path or parsed.query or parsed.fragment:
        raise HandoffError("Refusing non-loopback handoff endpoint")
    if int(info.get("expiresAt", 0)) < time.time():
        raise HandoffError("Handoff expired")
    token_path = state_dir / "claim-token.txt"
    token = token_path.read_text("ascii").strip()
    private_key = load_private(private_key_path)
    if public_key_fingerprint(private_key.public_key()) != info.get("fingerprint"):
        raise HandoffError("Recipient key fingerprint mismatch")
    status, body = _post_json(base_url, "/api/claim", "X-Claim-Token", token)
    if status != 200:
        raise HandoffError("No uploaded text is ready to receive")
    try:
        envelope = json.loads(body.decode("utf-8"))
        plaintext = decrypt_envelope(private_key, envelope, int(info["maxBytes"]))
    except Exception as exc:
        raise HandoffError("Received text failed validation") from exc

    try:
        if consumer is not None:
            view = memoryview(plaintext)
            try:
                consumer(view)
            finally:
                view.release()
        ack_status, _ = _post_json(base_url, "/api/ack", "X-Claim-Token", token)
        if ack_status != 200:
            raise HandoffError("Could not acknowledge received text")
        result = {
            "ok": True,
            "bytes": len(plaintext),
            "acknowledged": True,
            "plaintext_persisted": False,
            "consumer": "IN_PROCESS" if consumer is not None else "NONE",
        }
        if not quiet:
            print(
                "RECEIVE_OK=YES "
                f"bytes={result['bytes']} "
                "plaintext_persisted=NO "
                "acknowledged=YES "
                f"consumer={result['consumer']}"
            )
        return result
    finally:
        _wipe_buffer(plaintext)


def cleanup(state_dir: Path = STATE, inbox_dir: Path = INBOX) -> int:
    removed = 0
    for directory in (state_dir, inbox_dir):
        if directory.exists():
            for path in directory.iterdir():
                if path.is_file():
                    path.unlink(missing_ok=True)
                    removed += 1
    return removed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="One-time encrypted text handoff for local OpenCode")
    sub = parser.add_subparsers(dest="command", required=True)
    keygen = sub.add_parser("keygen")
    keygen.add_argument("--key-dir", type=Path, default=KEYS)
    serve = sub.add_parser("serve")
    serve.add_argument("--public-key", type=Path, default=KEYS / "recipient-public.pem")
    serve.add_argument("--state-dir", type=Path, default=STATE)
    serve.add_argument("--inbox-dir", type=Path, default=INBOX)
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--ttl", type=int, default=DEFAULT_TTL)
    serve.add_argument("--public-base-url")
    recv = sub.add_parser("receive")
    recv.add_argument("--state-dir", type=Path, default=STATE)
    recv.add_argument("--private-key", type=Path, default=KEYS / "recipient-private.pem")
    recv.add_argument("--quiet", action="store_true")
    clean = sub.add_parser("cleanup")
    clean.add_argument("--state-dir", type=Path, default=STATE)
    clean.add_argument("--inbox-dir", type=Path, default=INBOX)
    args = parser.parse_args(argv)
    try:
        if args.command == "keygen":
            private_path, public_path = generate_keypair(args.key_dir)
            print(f"KEYGEN_OK=YES\nPRIVATE_KEY_FILE={private_path}\nPUBLIC_KEY_FILE={public_path}")
            return 0
        if args.command == "serve":
            app = HandoffApp(args.public_key, args.state_dir, args.inbox_dir, args.ttl, public_base_url=args.public_base_url)
            app.start(args.port)
            print(f"SERVER_READY=YES\nUPLOAD_URL_FILE={app.upload_url_path}\nEXPIRES_AT={int(app.expires_at)}\nBIND=127.0.0.1:{app.httpd.server_address[1]}")
            app.serve_forever()
            return 0
        if args.command == "receive":
            receive(args.state_dir, args.private_key, quiet=args.quiet)
            return 0
        if args.command == "cleanup":
            print(f"CLEANUP_OK=YES removed={cleanup(args.state_dir, args.inbox_dir)}")
            return 0
    except HandoffError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    except Exception:
        print("ERROR: operation failed; details suppressed", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
