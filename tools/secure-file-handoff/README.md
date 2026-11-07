# Secure Text Handoff

A local-only, one-time text handoff from a phone browser to the OpenCode host.

## Security model

The phone browser accepts pasted text, such as a newly issued least-privilege token, in a textarea. It encodes the text as UTF-8 and encrypts it in the browser with AES-256-GCM. The random AES key is wrapped with the host's RSA-OAEP-3072 public key. Only the ciphertext envelope is sent to the server. The plaintext is not sent to the server, persisted in server storage, written to disk by the receive path, logged, placed in the URL, or shown back in status.

The server binds to 127.0.0.1 only. It enforces a one-upload capability, one local claim, a 10-minute expiry, and a 16 KiB UTF-8 plaintext limit. It has no CORS allowance, request logging, analytics, third-party scripts, or path-based file access. Private key and state files use restrictive permissions and attempt a Windows ACL limited to the current process identity.

## Current status

This is a local prototype. No production key has been generated, no server has been started, and no hostname or public route has been configured. Do not paste a real credential until the deployment hostname is protected by a restrictive Cloudflare Access policy and the exact route has been reviewed.

**Do not use a `trycloudflare` quick tunnel or `cloudflared tunnel --url`.** Quick tunnels are publicly reachable without verified Access protection and are not acceptable for carrying a real API token. Live phone use remains blocked until an exact hostname is verified behind restrictive Cloudflare Access.

## Requirements

Python 3.13+ and the already-installed `cryptography` package.

## Commands

Run from this directory:

    python handoff.py keygen

This generates the recipient keypair in `var/keys`. The private key remains on the host and must never be uploaded, committed, or pasted into a chat.

    python handoff.py serve --public-base-url https://YOUR-APPROVED-HOSTNAME

This starts the HTTP server on `127.0.0.1:8765`. It writes the one-time upload link to `var/state/upload-url.txt`; do not print or log that file's contents. The hostname must route to this local service through an already approved, Access-protected tunnel. The command does not create a tunnel or DNS record.

After the phone sends the encrypted text:

    python handoff.py receive

The decrypted text is held only in process memory. It is not written to disk, printed, logged, or included in command output. The command prints only redacted metadata such as byte count and acknowledgement state, then wipes the mutable plaintext buffer as best-effort. `--quiet` suppresses even that metadata. The server removes the encrypted pending text and local capability state after successful acknowledgement.

For a future trusted in-process consumer, `handoff.receive(..., consumer=callback)` accepts a callback that receives a read-only `memoryview` of the decrypted bytes. No such consumer is implemented or invoked in this prototype. The callback must not persist, print, or log the plaintext.

    python handoff.py cleanup

This removes pending state and ciphertext files. Do not run cleanup while a transfer is in progress.

## Phone workflow

1. Open the one-time upload URL from the host's local state file in the phone browser.
2. Paste the newly issued, least-privilege token into the textarea. Do not put it in the URL, a chat message, or a filename.
3. Press **Encrypt and send text**. The page encodes UTF-8 and encrypts locally; only ciphertext is uploaded. The textarea is cleared before encryption/upload.
4. OpenCode runs the local receive command. It decrypts in memory, prints only redacted metadata, and wipes the buffer. No plaintext output file is created; a future trusted in-process consumer is not part of this prototype.
5. Revoke the transfer credential after the approved work and create a fresh scoped credential if needed.

The URL fragment carries a short-lived upload capability. Treat the URL as private and do not share it. Never use a token previously pasted into a chat; it must be revoked and replaced first.

## Public deployment blocker

There is no verified exact hostname protected by a restrictive Cloudflare Access application and identity-based allow policy. A public quick tunnel or unprotected route would expose the handoff endpoint and is prohibited. The single missing prerequisite is the exact approved hostname plus evidence that its Access application restricts access to the intended identity before any publication.
