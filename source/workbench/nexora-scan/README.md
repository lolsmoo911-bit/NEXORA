# NEXORA Scan — read-only local explorer (workbench, hardened, loopback-only)

Status: local hardened read-only explorer (workbench). **No public deployment. No tunnel/DNS/Cloudflare changes. No public RPC exposure.** Binds loopback only.

## Purpose

A read-only block-explorer UI (blocks, tx lookup, address lookup, network status/gas)
with NO wallet connection, signing, private-key handling, token transfer, or write methods.

## Binding and exposure

- Server binds `127.0.0.1`/loopback only by default (refuses non-loopback `HOST`). Default port `18081` (`PORT`). `NEXORA_RPC_TARGET` must be loopback; non-loopback targets are rejected at server construction.
- It must NEVER be run on `0.0.0.0` and never exposed publicly. Tests bind ephemeral loopback ports and close servers; integration verification stops all own PIDs and checks listeners.

## RPC proxy contract (server.mjs) — hardened

- Same-origin backend proxy: browser calls `POST /api/rpc`; the server forwards only to loopback `NEXORA_RPC_TARGET` (default `http://127.0.0.1:8545`).
- **Strict read-only allowlist — exactly 8 methods:** `eth_chainId` `eth_blockNumber` `eth_getBlockByNumber` `eth_getTransactionByHash` `eth_getBalance` `eth_getTransactionCount` `eth_gasPrice` `net_version`. Everything else is rejected locally with `403 method_not_allowed` (including `eth_sendRawTransaction`, `personal_*`, `eth_sendTransaction`, `eth_sign`, `eth_accounts`, `admin_*`, `debug_*`, `txpool_*`, `miner_*`, `eth_call`, `eth_getCode`, unknown).
- **Chain ID 902024 enforced (fail closed):** upstream `eth_chainId` must verify as `0xdc388`/902024 (cached briefly). Proxy refuses with `502 chain_id_mismatch` or `upstream_chain_not_verified` when not verified; health reports mismatch/disconnected and never fabricates identity.
- **Envelope/params validation:** rejects batch arrays (`batch_not_supported`), requires `jsonrpc:"2.0"`, validates `method`/`params`/`id`, strict per-method param shapes (address `0x[40]`, hash `0x[64]`, block tags/hex, `eth_getBlockByNumber` requires `[tag, boolean]`). Invalid inputs return `400`.
- **Limits/timeouts:** bounded request body read 64 KB (`413`); bounded upstream response read 2 MB (`502 upstream_response_too_large`); upstream/proxy timeout 10s, probe 1.5s; per-IP rate limit 60 req/min (`429`). No secrets logged.
- `GET /api/health` probes `eth_chainId` (902024 required). If unavailable/mismatched, reports disconnected with no fabricated chain data.

## Network label / enforcement rule

Chain/network identity is shown ONLY from a live `eth_chainId` response **and proxying is allowed only when verified as NEXORA 902024 (`0xdc388`)**. Mismatch/disconnected => no fabricated identity, no proxied reads.

## Cloudflare / hostname status (BLOCKED for publication)

- Canonical hostname: `nexora-scan.sageswap.dpdns.org`.
- Redacted routing metadata inspected this session:
  - `.cloudflared/nexora-phase6-rpc.yml` (names only; credential JSON never read) maps
    `nexora-rpc.sageswap.dpdns.org -> http://127.0.0.1:3100` (that port is currently
    ECONNREFUSED — no gateway listening) — a different hostname, untouched.
  - No `nexora-scan` hostname is configured in either named config.
  - `opencode-web.yml` maps `opencode.sageswap.dpdns.org` — unrelated OpenCode/MCP
    tunnel, NOT modified.
- Publication rule: do NOT publish either NEXORA hostname unless Cloudflare Access is
  already configured and verified for the exact hostname AND the local service is
  read-only. Prior session reported no dashboard session/API token, so Access is
  UNVERIFIED in this session. The site therefore stays local-only. No public quick
  tunnel, no Everyone/Bypass policy, no unauthenticated RPC, no Access change.

## Tests / verification (2026-11-07)

```
cd workbench/nexora-scan && node --test test/scan.test.mjs
```
Result: **15/15 pass, 0 fail, exit 0.** Covers: 8-method read-only allowlist exactness; disconnected health with no fabricated identity; chain-ID mismatch handling (health + proxy rejected); UI static no-wallet/signing/send check; rejection of write/admin/personal/debug/txpool/miner/unknown (403); JSON-RPC envelope validation (batch rejected, jsonrpc/method/params/id); strict param/identifier validation; bounded 64KB request read (413); 60/min rate limit (429); proxy refused when chain not verified 902024 (dead upstream/mismatch); bounded 2MB upstream response cap after chain verification (502); allowlisted proxy behavior with verified 902024 fake upstream; 902024-only live labeling; loopback-only `rpcTarget` enforcement.

**Real disposable loopback chain verification (PASS, 2026-11-07):** started `evmd` against existing `workbench/local-testnet/home` on `127.0.0.1:8545` (own PID, not wiped), started nexora-scan on `127.0.0.1:18081`. Verified: index page 200 + “NEXORA Scan”/“No wallet”; `/api/health` connected, `chainId=902024`, `readOnly=true`, `expectedChainId=902024`; proxied `eth_chainId`/`eth_blockNumber`/`eth_gasPrice`/`eth_getBlockByNumber(['latest',false])` returned `result` (no error); `eth_sendRawTransaction` and `admin_peers` rejected 403 `method_not_allowed`. Both processes stopped (PID-scoped); **`post_stop_listeners=[]`** for 8545/8546/26657/26656/1317/9090/18081. No public exposure.

## How to run locally (debug only)

```
node server.mjs   # binds 127.0.0.1:18081; Ctrl-C stops it
```
Open `http://127.0.0.1:18081/`. With no chain node running it shows
Disconnected — network identity unavailable, with no data other than that status.
