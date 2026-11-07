# NEXORA — PUBLIC testnet endpoints (Replit free, $0)

**The network is publicly reachable. Verified from an external vantage point, not from inside.**

Cost: **$0**. No paid plan, no domain, no hosting purchased.

> **Read `docs/STATUS.md` first.** Everything on this page is TESTNET ONLY. Chain
> `eip155:902024` is retired for production use.

---

## Public endpoints

Base URL:

```
https://<tunnel>.trycloudflare.com/api/nexora
```

> **Correction (2026-10-13).** This document previously hard-coded
> `https://c60e4db5-…janeway.replit.dev/…`. That URL no longer resolves. Replit's free dev
> domains serve traffic through a private interception CA, so phones and non-Replit
> clients fail TLS verification against them even while they work from inside the Repl.
> The live endpoint is a **Cloudflare Tunnel**, which issues a real Google Trust Services
> certificate.
>
> **The tunnel URL is ephemeral.** It changes every time the tunnel restarts, and it dies
> whenever the Repl sleeps. It is not a service-level endpoint and must never be published
> as one. Anyone needing a durable endpoint has to pay for a host.

| Purpose | URL |
|---|---|
| Chain info + genesis SHA-256 | `…/api/nexora/info` |
| Cosmos RPC | `…/api/nexora/cosmos/…` |
| EVM JSON-RPC (POST) | `…/api/nexora/evm` |
| Block height | `…/api/nexora/cosmos/status` |
| Validator set | `…/api/nexora/cosmos/validators?per_page=10` |

The same paths under `/cosmos/` are CometBFT 0.39 read endpoints, so `/cosmos/block?height=N`,
`/cosmos/net_info`, `/cosmos/tx?hash=0x…` all work too.

**REST and WebSocket are not exposed.** The proxy forwards CometBFT read endpoints and EVM
JSON-RPC only. No WebSocket upgrade is handled, so no `ws://` endpoint is claimed.

---

## Verified externally

Fetched from an independent server, not from inside the Replit:

```json
{"node_info":{"id":"12370658a989edb94edefbc5b87d75d5b4c7e47b",
              "network":"eip155:902024","version":"0.39.0"},
 "sync_info":{"latest_block_height":"6609","catching_up":false,
              "latest_app_hash":"AE7B2214C44D216E6647D34A45ADA68F810575CFE618814E0AF8B41349B602FE"},
 "validator_info":{"address":"2E1CA93285D58942BA2E22FD893CCAC7C924C3A1","voting_power":"1000"}}
```

Over the public HTTPS URL:

```
eth_chainId      0xdc388
eth_blockNumber  0x19d5   (6613, tracks the Cosmos height)
net_version      902024

total voting power: 4000   (1000 x 4 validators)
```

Block production observed advancing across the public endpoint: **6618 → 6635 in 12 s**.

Four-node consensus, all four at height 6609, identical `app_hash`:

```
node0  AE7B2214C44D216E6647D34A45ADA68F
node1  AE7B2214C44D216E6647D34A45ADA68F
node2  AE7B2214C44D216E6647D34A45ADA68F
node3  AE7B2214C44D216E6647D34A45ADA68F
```

---

## Wallet settings

```
Network name      NEXORA Testnet
Cosmos chain-id   eip155:902024
EVM chain-id      902024   (0xdc388)
Currency symbol   ANEX
Decimals          18
RPC URL           https://…janeway.replit.dev/api/nexora/cosmos
EVM RPC URL       https://…janeway.replit.dev/api/nexora/evm
```

---

## Copy-paste commands

```bash
BASE=https://c60e4db5-67b2-4765-8c6b-0a614271da9e-00-21s1bbx8huijp.janeway.replit.dev/api/nexora

# block height
curl -s $BASE/cosmos/status | python3 -c 'import json,sys;s=json.load(sys.stdin)["result"]["sync_info"];print("height",s["latest_block_height"],"catching_up",s["catching_up"])'

# app_hash at a height
curl -s "$BASE/cosmos/block?height=6635" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["block"]["header"]["app_hash"])'

# validators + voting power
curl -s "$BASE/cosmos/validators?per_page=10" | python3 -c 'import json,sys;v=json.load(sys.stdin)["result"]["validators"];print("power:",sum(int(x["voting_power"]) for x in v))'

# EVM
curl -s -X POST $BASE/evm -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

**Sending transactions — CORRECTION.** An earlier version of this document said the gateway
is read-only. **That was wrong.** The proxy forwards the entire EVM JSON-RPC surface;
`eth_sendRawTransaction` reaches the node and returns the node's own errors (`rlp: value size
exceeds available input length`, `json: cannot unmarshal hex string…`), not a proxy refusal.
A correctly signed transaction would be broadcast.

The barrier to sending is **funding, not the gateway**: the only funded key here is a genesis
account from an upstream public test mnemonic, and new wallets hold 0 ANEX. See
`WALLET-SETUP.md` for what a faucet and an end-to-end send test still require.

Note that `/cosmos/*` is CometBFT **read** endpoints only — the application port on node0 is
not exposed, so there is no route for signing or broadcasting through the Cosmos side.

---

## How this works

Replit's public dev domain forwards only the `/api/*` and `/__mockup/*` path prefixes to the
server process; anything else returns `Backend Not Configured` from Replit's router before
reaching the process. The chain proxy is therefore mounted at `/api/nexora/*`, ahead of the
app's own router, in `artifacts/api-server/src/nexoraProxy.ts`.

It must sit **above** `express.json()`. That parser consumes the request stream, so a proxy
below it finds the body already gone — GETs survive (no body), which is why `/cosmos/status`
worked while every EVM POST silently returned nothing.

Remove the two lines in `app.ts` (`import` + `app.use(nexoraProxy)`) to disable it. No other
route changes.

---

## Honest limitations

| Limitation | Detail |
|---|---|
| **Read-only** | Balances and chain state are queryable. Transactions must be sent from the operator's machine. |
| **Single host** | All four validators are on one machine. One host loss ends consensus. It is **not** a distributed network of independent operators. |
| **Not always-on** | A free Replit sleeps when idle. The endpoint disappears while asleep and the validators stop. Nothing here survives unattended for days. |
| **Public read endpoints only** | CometBFT read paths and EVM JSON-RPC. No REST API, no WebSocket. |
| **URL may change** | The Replit dev domain is tied to this Repl. A different Repl means a different URL. |
| **P2P not externally reachable** | Validators bind loopback. No external node can peer with them, so there are no usable `persistent_peers` addresses. |
| **Test keys** | Validator and wallet keys are the upstream public test mnemonics. They hold no value and must never hold any. |

**Classification: a publicly readable, single-host testnet.** Reachable and working, but not
an independently-operated network and not always-on.

---

## Correction to earlier reporting

Earlier notes in this repository stated that Replit ingress was broken and that the dev domain
was login-gated. **Both were wrong.** The "broken" conclusion came from appending `:8080` to
the hostname, which Replit ignores. The "login-gated" conclusion came from a single proxy
service that returned a false negative. An independent fetch shows the endpoint is public.
The correct statement is the one in this document: the chain is publicly readable at the URLs
above, and the real limitations are read-only access, single-host operation, and Replit's
sleep behaviour.---

## 2026-10-12 — outage cause, and a proxy bug found while fixing it

### The endpoint was DOWN, not misconfigured

Trust Wallet could not read the chain ID because **all four validators were dead**. The
Replit container restarted and `/tmp` was wiped — on Replit `/tmp` is ephemeral. Everything
had been living there: the `evmd` binary, the chain state, and the repository clone. The
`api-server` survived only because it is launched from `/home/runner/workspace`.

`eth_chainId` was not being rejected. There was no node behind the proxy to answer it.

### Relocated to persistent storage

| Item | Old — lost on every restart | New — persistent |
|---|---|---|
| `evmd` binary | `/tmp/opencode/cosmos-evm` | `/home/runner/workspace/nexora-chain/cosmos-evm` |
| Chain state | `/tmp/opencode/nexora-testnet` | `/home/runner/workspace/nexora-chain/testnet` |
| Repository | `/tmp/opencode/NEXORA` | `/home/runner/workspace/nexora-chain/NEXORA` |

Genesis regenerated **byte-for-byte identical**:
`33d94dd053106f0666f21a526c4addd8660c833cb2d0465f63cb90beeca4d847` — deterministic, as designed.

### Second bug: the proxy dropped response headers

`nexoraProxy` forwarded only `content-type` and piped the body. geth's RPC server honours
`Accept-Encoding` and replies gzip-encoded when asked, so gzip bytes arrived with **no
`content-encoding` header**. Any client that negotiated compression then tried to parse
compressed data as JSON and failed.

**curl omits `Accept-Encoding: gzip` by default, so every earlier test passed.** Trust Wallet
sends it, which is why the failure appeared only in the wallet and nowhere in the test suite.

Fixed: request headers forwarded (minus hop-by-hop), `content-length` set, and every upstream
response header copied through.

### Re-verified externally after the fix

```
POST /api/nexora/evm   Accept-Encoding: gzip
  -> HTTP/2 200, valid JSON, {"result":"0xdc388"}

eth_chainId      HTTP 200  0xdc388
eth_blockNumber  HTTP 200  0x23   (35)
eth_getBalance   HTTP 200  1000.75 ANEX

/cosmos/status via independent external fetch:
  network eip155:902024, catching_up false, voting_power 1000
```

Four validators, identical `app_hash` at every checked height.

### Still true

Free. No paid resource, no Mainnet, no purchase, no domain. Keys remain the upstream public
test mnemonics and hold no value.