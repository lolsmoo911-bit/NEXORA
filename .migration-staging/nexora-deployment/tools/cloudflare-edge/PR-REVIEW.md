# PR review — NEXORA Cloudflare RPC edge

## Scope

Adds an isolated Node 24 edge gateway for the Phase 6 EVM compatibility probe path. It is not merged into the canonical NEXORA source tree.

## API

- `GET /health`: reports gateway readiness only; `originChecked` is always false.
- `POST /evm`: forwards JSON-RPC 2.0 request/response traffic to the configured upstream URL.
- All other paths are 404; unsupported HTTP methods are 405.

## Security review

- Server binds to `127.0.0.1` only.
- Fixed allowlist: `eth_chainId`, `net_version`, `eth_blockNumber`, `eth_syncing`, `eth_getBlockByNumber`, `eth_gasPrice`, `eth_getBalance`, `eth_getTransactionCount`, `web3_clientVersion`.
- Any non-allowlisted method receives JSON-RPC `-32601`; blocked requests are never sent upstream.
- JSON-RPC version, method, and ID shape are validated. Notifications are rejected.
- Batch requests preserve response order and filter blocked methods before forwarding.
- Request body is capped at 1 MiB. Upstream timeout is bounded; unavailable and timeout paths return 502/504.
- CORS is empty by default; wildcard origins are rejected. Exact configured origins are echoed.
- `cache-control: no-store` and `x-content-type-options: nosniff` are set.
- No signing, private keys, wallet methods, write methods, or transaction submission are implemented.
- Upstream URL is never exposed in health output or request logs.

## Review notes / remaining production work

- Add Cloudflare Access or caller authentication plus rate limiting/quotas before allowing unrestricted public use.
- Add monitoring, abuse controls, and operational ownership before production.
- Live EVM node, Cloudflare connector, public DNS propagation, and end-to-end RPC are not verified.
- The current user-level Tunnel config is intentionally not changed in this workbench; the old route to port 3000 must not be used for public exposure.

## Files

- `src/rpc-gateway.mjs`
- `src/gateway-bin.mjs`
- `test/rpc-gateway.test.mjs`
- `configs/nexora-phase6-rpc.port3100.example.yml`
- `TUNNEL-SETUP.md`
