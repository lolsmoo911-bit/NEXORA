import base64
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import handoff


class HandoffTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.private_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        cls.public_key = cls.private_key.public_key()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.key_dir = self.root / "keys"
        self.state = self.root / "state"
        self.inbox = self.root / "inbox"
        self.out = self.root / "out"
        handoff.secure_dir(self.key_dir)
        handoff.secure_dir(self.out)
        private_pem = self.private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        public_pem = self.public_key.public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        self.private_path = self.key_dir / "recipient-private.pem"
        self.public_path = self.key_dir / "recipient-public.pem"
        handoff.secure_write(self.private_path, private_pem)
        handoff.secure_write(self.public_path, public_pem)
        self.app = handoff.HandoffApp(self.public_path, self.state, self.inbox, ttl_seconds=60)
        self.app.start(port=0)
        self.thread = threading.Thread(target=self.app.serve_forever, daemon=True)
        self.thread.start()
        self.base = self.app.local_base_url

    def tearDown(self):
        try:
            if self.app.httpd:
                self.app.httpd.shutdown()
                self.app.httpd.server_close()
            if self.app.timer:
                self.app.timer.cancel()
        finally:
            self.temp.cleanup()

    def request(self, path, method="GET", body=None, headers=None):
        req = urllib.request.Request(
            self.base + path,
            data=body,
            method=method,
            headers=headers or {},
        )
        try:
            with urllib.request.urlopen(req, timeout=3) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers, exc.read()

    def upload(self, envelope):
        return self.request(
            "/api/upload",
            "POST",
            handoff.json_bytes(envelope),
            {"Content-Type": "application/json", "X-Upload-Token": self.app.upload_token},
        )

    def test_utf8_text_hybrid_round_trip_and_authentication(self):
        text = "dummy-token-π-日本\n"
        content = text.encode("utf-8")
        envelope = handoff.encrypt_for_test(self.public_key, content)
        self.assertEqual(handoff.decrypt_envelope(self.private_key, envelope), content)
        self.assertEqual(handoff.decrypt_envelope(self.private_key, envelope).decode("utf-8"), text)
        changed = dict(envelope)
        changed["ciphertext"] = envelope["ciphertext"][:-4] + "AAAA"
        with self.assertRaises(handoff.HandoffError):
            handoff.decrypt_envelope(self.private_key, changed)

    def test_ciphertext_only_single_text_send_and_receive(self):
        text = "dummy-cloudflare-token-for-test"
        content = text.encode("utf-8")
        envelope = handoff.encrypt_for_test(self.public_key, content)
        status, headers, _ = self.upload(envelope)
        self.assertEqual(status, 201)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

        pending_files = list(self.inbox.glob("*.ciphertext.json"))
        self.assertEqual(len(pending_files), 1)
        stored = pending_files[0].read_bytes()
        self.assertNotIn(content, stored)
        for path in list(self.state.iterdir()) + list(self.inbox.iterdir()):
            if path.is_file():
                self.assertNotIn(content, path.read_bytes())
        self.assertNotIn(content, self.request("/api/status")[2])

        second_status, _, _ = self.upload(envelope)
        self.assertEqual(second_status, 409)

        result = handoff.receive(self.state, self.private_path, quiet=True)
        self.assertTrue(result["ok"])
        self.assertEqual(result["bytes"], len(content))
        self.assertTrue(result["acknowledged"])
        self.assertFalse(result["plaintext_persisted"])
        self.assertEqual(result["consumer"], "NONE")
        self.assertNotIn(content, json.dumps(result).encode("utf-8"))
        self.assertEqual(list(self.inbox.iterdir()), [])
        self.assertEqual(list(self.out.iterdir()), [])
        self.assertFalse((self.state / "claim-token.txt").exists())
        for base in (self.root, self.state, self.inbox, self.out):
            if base.exists():
                for path in base.rglob("*"):
                    if path.is_file():
                        self.assertNotIn(content, path.read_bytes())

    def test_claim_is_single_use(self):
        envelope = handoff.encrypt_for_test(self.public_key, b"dummy-text-entry")
        self.assertEqual(self.upload(envelope)[0], 201)
        headers = {"X-Claim-Token": self.app.claim_token}
        first, _, _ = self.request("/api/claim", "POST", b"{}", headers)
        second, _, _ = self.request("/api/claim", "POST", b"{}", headers)
        self.assertEqual(first, 200)
        self.assertEqual(second, 409)
        ack, _, _ = self.request("/api/ack", "POST", b"{}", headers)
        self.assertEqual(ack, 200)
        self.assertEqual(list(self.inbox.iterdir()), [])

    def test_public_page_security_headers_and_no_directory_listing(self):
        status, headers, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn(b"End-to-end encrypted in this browser", body)
        self.assertIn(b"<textarea", body)
        self.assertNotIn(b'type="file"', body)
        self.assertIn(b"Paste the token", body)
        self.assertIn("script-src 'self'", headers.get("Content-Security-Policy", ""))
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.request("/%2e%2e/secret")[0], 404)

        js_status, _, js_body = self.request("/app.js")
        self.assertEqual(js_status, 200)
        self.assertIn(b"crypto.subtle", js_body)
        self.assertIn(b"TextEncoder", js_body)
        self.assertIn(b"AES-GCM", js_body)
        self.assertIn(b"RSA-OAEP", js_body)
        self.assertNotIn(b"https://", js_body)
        self.assertNotIn(b"localStorage", js_body)
        self.assertNotIn(b"sessionStorage", js_body)
        self.assertNotIn(b"console.", js_body)

    def test_expired_text_upload_is_rejected(self):
        self.app.expires_at = time.time() - 1
        envelope = handoff.encrypt_for_test(self.public_key, b"test")
        status, _, _ = self.upload(envelope)
        self.assertEqual(status, 410)
        self.assertEqual(list(self.inbox.iterdir()), [])

    def test_text_at_size_limit_round_trips(self):
        content = b"x" * handoff.MAX_BYTES
        envelope = handoff.encrypt_for_test(self.public_key, content)
        self.assertEqual(handoff.decrypt_envelope(self.private_key, envelope), content)

    def test_text_size_limit_is_enforced(self):
        with self.assertRaises(handoff.HandoffError):
            handoff.encrypt_for_test(self.public_key, b"x" * (handoff.MAX_BYTES + 1))

        oversized = {
            "v": 1,
            "iv": base64.b64encode(b"0" * 12).decode("ascii"),
            "wrappedKey": base64.b64encode(b"0" * (self.public_key.key_size // 8)).decode("ascii"),
            "ciphertext": base64.b64encode(b"x" * (handoff.MAX_BYTES + 17)).decode("ascii"),
        }
        status, _, _ = self.upload(oversized)
        self.assertEqual(status, 400)
        self.assertEqual(list(self.inbox.iterdir()), [])

    def test_oversized_http_body_is_rejected(self):
        body = b"x" * (self.app.max_bytes * 2 + 4097)
        status, _, _ = self.request(
            "/api/upload",
            "POST",
            body,
            {"Content-Type": "application/json", "X-Upload-Token": self.app.upload_token},
        )
        self.assertEqual(status, 413)

    def test_invalid_envelope_is_rejected(self):
        status, _, _ = self.upload({"v": 1, "unexpected": "input"})
        self.assertEqual(status, 400)
        self.assertEqual(list(self.inbox.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
