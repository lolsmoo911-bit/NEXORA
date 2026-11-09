# Serving the NEXORA testnet publicly — full setup

How the public endpoint at `…janeway.replit.dev/api/nexora/*` is actually produced, so it can
be rebuilt from this repository alone. Free. No paid plan, no domain, no Mainnet.

---

## What is involved

```
Replit public dev domain
        │  (routes ONLY /api/* and /__mockup/* prefixes)
        ▼
api-server  (Express, already published on the Repl, port 8080)
        │  app.use(nexoraProxy)   ← mounted ABOVE express.json()
        ▼
127.0.0.1:26657  CometBFT     (Cosmos read endpoints)
127.0.0.1:8545   EVM JSON-RPC
```

Validators bind loopback only, so they are never exposed directly. The proxy is what makes
the chain readable from outside.

---

## 1. The proxy source

`scripts/nexora-proxy-express.ts` in this repository is a copy of the file that runs in the
Replit workspace at `artifacts/api-server/src/nexoraProxy.ts`. Copy it in:

```bash
cp scripts/nexora-proxy-express.ts artifacts/api-server/src/nexoraProxy.ts
```

It serves:

| Path | Forwards to |
|---|---|
| `/api/nexora/info` | chain id, EVM chain id, denom, genesis SHA-256 |
| `/api/nexora/cosmos/*` | `http://127.0.0.1:26657/*` |
| `/api/nexora/evm` | `http://127.0.0.1:8545/*` |

### Why `/api/nexora` and not `/nexora`

Replit's router forwards only the `/api/*` and `/__mockup/*` prefixes to the process. Any
other path returns `404 Backend Not Configured` **from Replit's router**, before the request
ever reaches the app. Verified:

```
/api/healthz          200   (routed)
/api/nonexistent      404   (routed, app's own 404)
/cosmos/status        404   Backend Not Configured
/chain-info           404   Backend Not Configured
```

---

## 2. The `app.ts` wiring

Two changes in `artifacts/api-server/src/app.ts`. Everything else is untouched, and the
`/api` router behaves exactly as before.

```diff
 import router from "./routes";
+import { nexoraProxy } from "./nexoraProxy";
 import { logger } from "./lib/logger";

 app.use(cors());
-app.use(express.json());
-app.use(express.urlencoded({ extended: true }));
+
+// NEXORA testnet read-only proxy (/api/nexora/*).
+app.use(nexoraProxy);
+
+app.use(express.json());
+app.use(express.urlencoded({ extended: true }));

 app.use("/api", router);
```

### The middleware MUST sit above `express.json()`

`express.json()` consumes the request stream. A proxy mounted below it finds the body already
gone. **GETs survive that** — they have no body — which is why `/api/nexora/cosmos/status`
appeared to work while every EVM **POST** silently returned nothing. Do not move it down.

### Response headers must be forwarded

The first version forwarded only `content-type` and piped the body. geth honours
`Accept-Encoding` and replies gzip-encoded when asked, so gzip bytes arrived with no
`content-encoding` header and the client tried to parse compressed data as JSON.

**curl omits `Accept-Encoding: gzip` by default, so this stayed invisible in testing.**
Trust Wallet sends it. The shipped proxy forwards request headers and copies every upstream
response header through.

---

## 3. Starting the chain

Chain state and the binary live under the Replit's persistent workspace — **not `/tmp`**,
which Replit wipes on every container restart.

```bash
export NEX=/home/runner/workspace/nexora-chain
export PATH="$NEX/cosmos-evm/build:$PATH"
export WORK="$NEX/testnet"
export COSMOS_EVM_DIR="$NEX/cosmos-evm"
export EVM="$NEX/cosmos-evm/build/evmd"

bash "$NEX/NEXORA/ci/testnet/start-local-node.sh"
```

Upstream is verified by commit hash (`c3ae9067…`) before anything builds. Genesis is
deterministic: `33d94dd053106f0666f21a526c4addd8660c833cb2d0465f63cb90beeca4d847`.

Stop with `ci/testnet/stop.sh`.

---

## 4. Starting the API server

```bash
cd artifacts/api-server
pnpm run build
PORT=8080 \
NEXORA_GENESIS_FILE=/home/runner/workspace/nexora-chain/testnet/genesis.json \
  node --enable-source-maps ./dist/index.mjs
```

---

## 5. Verifying from outside

Do not trust a local test. From an external client:

```bash
BASE=https://<repl-dev-domain>/api/nexora

curl -s -X POST $BASE/evm \
  -H 'content-type: application/json' -H 'Accept-Encoding: gzip' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
# -> {"result":"0xdc388"}

curl -s -X POST $BASE/evm -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

curl -s $BASE/cosmos/status
curl -s $BASE/info
```

Include `Accept-Encoding: gzip` deliberately. Without it you are testing a path that does
not reproduce the wallet failure.

---

## 6. Removing it

Delete the `import` and the `app.use(nexoraProxy)` line from `app.ts`, then rebuild. No
other route is affected.

---

## Limitations

| Limitation | Detail |
|---|---|
| Free Replit sleeps | Validators and endpoint stop when the Repl is idle. This is the dominant fragility — if the endpoint stops answering, check this first. |
| Single host | All four validators on one machine. Not an independently operated network. |
| Cosmos side is read-only | `/cosmos/*` maps to CometBFT read endpoints only. There is no REST API and no WebSocket. |
| EVM side is not blocked | The gateway forwards the whole EVM JSON-RPC surface, including `eth_sendRawTransaction`. Sending is stopped by **funding**, not by the gateway. See `WALLET-SETUP.md`. |
| P2P not exposed | Validators bind loopback; no usable `persistent_peers` addresses exist. |
| Test keys | Upstream public test mnemonics. No value, ever. |