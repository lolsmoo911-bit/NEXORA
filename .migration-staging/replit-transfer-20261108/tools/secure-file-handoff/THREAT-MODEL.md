# Threat Model — Secure Text Handoff

## Assets

- Cloudflare API token or other short secret pasted into the phone browser textarea.
- Recipient RSA private key on the OpenCode host.
- One-time upload capability and local claim capability.
- Ciphertext waiting for local receipt.

## Trust boundaries

- Phone browser: accepts the pasted text, encodes it as UTF-8, and performs WebCrypto encryption.
- HTTP relay: untrusted for confidentiality; sees only the ciphertext envelope, metadata, and the one-time upload capability header. It never receives plaintext.
- OpenCode host: holds the private key and decrypts the received envelope in memory. The receive path does not write, print, log, or return plaintext; an optional trusted in-process consumer may inspect a memoryview before the buffer is wiped.
- Cloudflare Access and tunnel edge: must authenticate the phone user before routing the exact hostname to the local server.

## Security controls

- AES-256-GCM encrypts UTF-8 text in the browser; RSA-OAEP-3072 wraps the AES key.
- A fixed authenticated-data label binds the envelope to this handoff protocol.
- The relay persists only a canonical ciphertext envelope under a generated filename.
- The textarea is cleared before encryption/upload. Plaintext is not placed in the URL, status text, logs, cookies, local storage, or session storage.
- The receive path holds plaintext in a mutable `bytearray`, optionally passes a read-only `memoryview` to an in-process consumer, then zeroes and clears the buffer. No plaintext output file is created, and CLI output contains only redacted metadata.
- Exact route allowlist; no arbitrary paths, file names, uploads by path, directory listing, or wildcard CORS.
- Loopback-only bind, 16 KiB plaintext cap, 10-minute TTL, single upload, single claim, and cleanup after acknowledgement/expiry.
- Request logging disabled; no analytics, external assets, or third-party scripts.
- Private key and state files are written with restrictive modes and a best-effort current-identity Windows ACL.
- Browser upload token is placed in the URL fragment and removed from browser history after page load.

## Residual risks and blockers

- The browser page must be served over HTTPS from the exact hostname protected by a restrictive Cloudflare Access policy. No such exact-host policy has yet been verified; public deployment is blocked. A `trycloudflare` quick tunnel or `cloudflared tunnel --url` is not an acceptable substitute because it is publicly reachable without verified Access protection.
- A compromised phone browser, browser extension, keyboard, clipboard, or OpenCode host can read plaintext before encryption or after decryption.
- The local host process currently runs as `NT AUTHORITY\SYSTEM`. This is broader than a dedicated service identity; a least-privilege Windows account is preferred before production use.
- RSA private-key bytes are protected by filesystem ACLs, not hardware-backed storage. Anyone who can read the host private key can decrypt the text.
- A malicious operator of the relay can deny service or replay ciphertext, though authentication and one-time state checks constrain acceptance.
- Any future in-process consumer must not persist, print, or log the plaintext it receives. No such consumer is implemented in this prototype.
- The transfer text must be kept small; this is not a general file-sharing service.
- This prototype has not been penetration-tested and must not be treated as production-ready.
