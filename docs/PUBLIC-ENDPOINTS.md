# NEXORA — PUBLIC testnet endpoints (Replit free, $0)

**The network is publicly reachable. Verified from an external vantage point, not from inside.**

Cost: **$0**. No paid plan, no domain, no hosting purchased.

---

## Public endpoints

Base URL:

```
https://c60e4db5-67b2-4765-8c6b-0a614271da9e-00-21s1bbx8huijp.janeway.replit.dev/api/nexora
```

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
              "network":"nexora-devnet-1","version":"0.39.0"},
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
Cosmos chain-id   nexora-devnet-1
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

**Sending transactions:** the public endpoint is **read-only**. It proxies only CometBFT read
endpoints and EVM JSON-RPC; the application port on node0 is deliberately not exposed, so
nothing signed or broadcast can pass through it. A transfer must be submitted from the
operator's own machine with `evmd tx bank send` — see `COMMANDS.md`.

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
sleep behaviour.