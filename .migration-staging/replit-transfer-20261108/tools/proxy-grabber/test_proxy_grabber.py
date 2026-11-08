import unittest
from proxy_grabber import parse_candidate

class ParseCandidateTests(unittest.TestCase):
    def test_http_uri(self):
        self.assertEqual(parse_candidate("http://8.8.8.8:8080", "http"), ("http", "8.8.8.8", 8080))
    def test_socks5_uri(self):
        self.assertEqual(parse_candidate("socks5://1.1.1.1:1080", "http"), ("socks5", "1.1.1.1", 1080))
    def test_unprefixed_uses_source_protocol(self):
        self.assertEqual(parse_candidate("9.9.9.9:3128", "socks5"), ("socks5", "9.9.9.9", 3128))
    def test_private_and_loopback_rejected(self):
        for value in ("127.0.0.1:8080", "192.168.1.10:3128", "10.1.2.3:1080"):
            self.assertIsNone(parse_candidate(value, "http"))
    def test_bad_ports_and_domains_rejected(self):
        for value in ("8.8.8.8:0", "8.8.8.8:65536", "proxy.example:8080", "8.8.8.8:notaport"):
            self.assertIsNone(parse_candidate(value, "http"))
    def test_credentials_are_not_imported(self):
        self.assertIsNone(parse_candidate("http://user:pass@8.8.8.8:8080", "http"))
    def test_unsupported_protocol_rejected(self):
        self.assertIsNone(parse_candidate("socks4://8.8.8.8:1080", "http"))

if __name__ == "__main__":
    unittest.main(verbosity=2)

