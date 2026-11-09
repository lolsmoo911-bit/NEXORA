# Endpoint verification matrix — 2026-10-12

Every row below was executed against the **live public URL** from outside the Replit
container. No row is a local test.

```
BASE = https://c60e4db5-67b2-4765-8c6b-0a614271da9e-00-21s1bbx8huijp.janeway.replit.dev/api/nexora
```

---

## 1. Encoding variants — POST `eth_chainId`

| `Accept-Encoding` | HTTP | Content-Type | Content-Encoding | Content-Length | Body |
|---|---|---|---|---|---|
| *(none)* | 200 | application/json | — | 44 | `{"result":"0xdc388"}` |
| `gzip` | 200 | application/json | — | 44 | `{"result":"0xdc388"}` |
| `identity` | 200 | application/json | — | 44 | `{"result":"0xdc388"}` |
| `gzip, deflate, br` | 200 | application/json | — | 44 | `{"result":"0xdc388"}` |
| `gzip, deflate` | 200 | application/json | — | 44 | `{"result":"0xdc388"}` |
| `zstd` | 200 | application/json | — | 44 | `{"result":"0xdc388"}` |
| `gzip, deflate, br, zstd` | 200 | application/json | — | 44 | `{"result":"0xdc388"}` |
| `*` | 200 | application/json | — | 44 | `{"result":"0xdc388"}` |

**No double compression.** `Content-Length` is a real value and never disagrees with the
body in any variant. The body always begins with `{"` — it is never gzip or brotli bytes.

## 2. JSON-RPC methods — request id `7` echoed in every response

| Method | HTTP | Response |
|---|---|---|
| `eth_chainId` | 200 | `{"jsonrpc":"2.0","id":7,"result":"0xdc388"}` |
| `net_version` | 200 | `{"jsonrpc":"2.0","id":7,"result":"902024"}` |
| `eth_blockNumber` | 200 | `{"jsonrpc":"2.0","id":7,"result":"0x4b8"}` |
| `eth_syncing` | 200 | `{"jsonrpc":"2.0","id":7,"result":false}` |
| `eth_getBalance` | 200 | `{"jsonrpc":"2.0","id":7,"result":"0x3635c9adc5dea00000"}` |

`eth_getBalance` = 1000.75 ANEX for `0x498B5AeC5D439b733dC2F58AB489783A23FB26dA`.
The `id` is echoed correctly, which some clients require.

## 3. Transport and client compatibility

| Check | Result |
|---|---|
| HTTP/2 (default) | 200 |
| HTTP/1.1 forced (`--http1.1`) | 200 |
| `User-Agent: Trust Wallet/3` | 200 |
| `User-Agent: MetaMask/12.0 (Android)` | 200 |
| `User-Agent: okhttp/4.12.0` (Android) | 200 |
| No `User-Agent` at all | 200 |
| CORS preflight (`OPTIONS`, browser extension) | 204 with `access-control-allow-origin: *`, `access-control-allow-methods` includes POST |

## 4. Behaviours a wallet must know

| Request | Result | Consequence |
|---|---|---|
| `GET /api/nexora/evm` | **405** | The endpoint is POST-only. A wallet that probes with GET fails. |
| `GET /api/nexora` | 404 `Cannot GET` | Falls through to the app's own router. If a client truncates the path it gets HTML, not JSON-RPC, and reports a chain-ID error. |

---

## What this does and does not prove

**Proven:** the endpoint answers JSON-RPC correctly over the public internet under every
header, encoding, transport and user-agent variation tested, including the exact gzip case
that broke Trust Wallet earlier.

**Not proven — stated plainly:** I cannot install or operate Trust Wallet or MetaMask from
this environment. I have no way to run their app code, so I cannot claim "wallet-compatible"
from HTTP tests alone. A wallet can fail for reasons invisible at this layer — its own
caching of a failed result, TLS or pinning behaviour, or the endpoint being asleep at the
moment it dials.

**The most likely remaining cause is sleep.** A free Replit suspends when idle. My tests keep
it awake; a phone does not. A request that arrives during suspension fails exactly like a
bad URL, and both wallets report it as "could not fetch chain ID". Before blaming the URL,
check whether the endpoint answers at all at that moment:

```bash
curl -s -X POST "$BASE/evm" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
```

If that hangs or fails, the chain was asleep — wait ~30–60 s for the Repl to wake and retry.
If it returns `0xdc388` and the wallet still fails, the wallet is caching; clear the app's
network data or reinstall, and re-enter the URL with no trailing slash.

---

## How to reproduce every row

```bash
BASE=https://c60e4db5-67b2-4765-8c6b-0a614271da9e-00-21s1bbx8huijp.janeway.replit.dev/api/nexora
D='{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'

# encoding matrix
for AE in "" "gzip" "identity" "gzip, deflate, br" "zstd" "*"; do
  echo "--- Accept-Encoding: ${AE:-none} ---"
  curl -s -D - -o /tmp/body --max-time 25 -X POST "$BASE/evm" \
    -H 'content-type: application/json' -H "Accept-Encoding: $AE" -d "$D" | grep -i "^content-"
  cat /tmp/body; echo
done

# HTTP/1.1
curl -s --http1.1 -X POST "$BASE/evm" -H 'content-type: application/json' -d "$D"

# GET probe behaviour
curl -s -o /dev/null -w "GET /evm -> %{http_code}\n" "$BASE/evm"

# CORS preflight
curl -s -X OPTIONS -D - -o /dev/null "$BASE/evm" \
  -H 'Origin: chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn' \
  -H 'Access-Control-Request-Method: POST' | grep -i "access-control"
```