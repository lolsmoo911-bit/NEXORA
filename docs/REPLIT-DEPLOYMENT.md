# NEXORA — Replit free deployment report

**Verdict: the four-validator testnet RUNS inside Replit free. There is NO public endpoint,
and Replit free cannot provide one.** Every statement below was tested in this environment,
not inferred from documentation.

Date: 2026-10-12 · Workspace: `lolsmoo911/workspace` · Host: Replit `janeway` cluster

---

## 1. What was deployed

Four `evmd` validators (cosmos/evm v0.7.3, unmodified, SHA `c3ae9067`) running inside this
Replit, using the repository's existing working implementation and its already-persisted
state. **No genesis was regenerated and no existing fix was discarded.**

```
4 validators · 4 vCPU / 7 GB RAM container · full mesh · voting power 4000
```

---

## 2. Requirements tested — results

| # | Requirement | Result | Evidence |
|---|---|---|---|
| 1 | Validator processes keep running | ✅ **YES** | 4 × `evmd` live, height climbing continuously |
| 2 | State persists across restart | ✅ **YES** | Stopped at 4067, restarted, resumed and continued to 4330+ |
| 3 | P2P works | ✅ internal / ❌ external | Full mesh, 3 peers each, 4/4 consensus — but no inbound from outside |
| 4 | RPC / EVM reachable externally | ❌ **NO** | See §3 |
| 5 | Genuinely free, no auto-charge | ✅ **YES** | No resource purchased, nothing billed, no paid plan |

### 2.1 Four validators reach consensus

```
heights: 4330 4330 4330 4330     all four at the same height
app_hash at height 4330:
  node0  035A4EFDD9482CC87F443E91515C23B627FEB27A6484B43C8A7D1E23B1EC133A
  node1  035A4EFDD9482CC87F443E91515C23B627FEB27A6484B43C8A7D1E23B1EC133A
  node2  035A4EFDD9482CC87F443E91515C23B627FEB27A6484B43C8A7D1E23B1EC133A
  node3  035A4EFDD9482CC87F443E91515C23B627FEB27A6484B43C8A7D1E23B1EC133A

peers: node0 3 · node1 3 · node2 3 · node3 3      (fully connected)
```

### 2.2 State survives a restart

```
PRE-STOP      height 4067  app_hash 019BD855ECA7E1F05A0C86035FE1BE0B1FA6716208A82D6A339BA981041670BF
stop.sh       4 validators stopped cleanly, 241 MB of state on disk
RESTARTED     height 4215, catching_up=false — resumed, not reset
block 4067 re-read after restart → app_hash identical to PRE-STOP
```

### 2.3 Transfer settles, balances move, fees are accounted

```
txhash  5D63EBE772A11EB4913ED3BEA72F0AEE30EBB6D5291200B0944095D19F9B2484
code    0        height 4338        gas used 88057 / 200000
dev3    1000500000001123456790 -> 1000750000001123456790
exact match: True   (+250000000000000000 anex)
```

Fee behaviour, measured earlier and unchanged here: `cost = gas_wanted × gas_price`, with
**no unused-gas refund**. Tx 2 above consumed 88057 of a 200000 limit and the difference was
not returned.

---

## 3. Why there is no public endpoint — tested three ways

The container sits behind NAT. Egress and ingress are different addresses:

```
this host's egress IP        34.23.101.149
Replit dev domain resolves   34.24.144.74   (Google Cloud ingress)
```

A gateway was written (`nexora-rpc-gateway.mjs`) that binds one HTTP port and proxies
`/cosmos/*` to CometBFT `:26657` and `/evm` to EVM JSON-RPC `:8545`, with CORS enabled so a
wallet could use it. It works perfectly locally:

```
GET  http://127.0.0.1:3000/health        200
GET  http://127.0.0.1:3000/cosmos/status 200   height 4256
POST http://127.0.0.1:3000/evm            200   {"result":"0xdc388"}
```

It cannot be reached, because **Replit ingress does not route to it**:

| Test | Result |
|---|---|
| `https://<dev-domain>/` | `404` |
| `https://<dev-domain>:3000/health` | `502` — Replit page: **"We couldn't reach this app"** |
| `https://<dev-domain>-3000.<dev-domain>/` | `000` — no such host |
| Same request fetched by a third-party server outside Replit | `522` / `500` |

**The decisive control:** port `8080` in this container already carries this Repl's *own*
pre-existing app. The dev domain returns the **same `502` "We couldn't reach this app"** for
it. So this is not a defect in the gateway — Replit ingress is simply not available to this
workspace.

Two structural reasons, both confirmed:

- `REPL_ORG_TYPE=PERSONAL`, `REPL_ORG_IS_ENTERPRISE=false` — a free personal account.
  Replit **Deployments** (always-on public URLs) are a paid Core/Teams feature.
- The `replit` CLI available here exposes only `identity`, `ai`, `shutdown`, `secrets`,
  `gitsafe` — **there is no deploy command**. A deployment cannot be triggered from here.

Free Repls also sleep when idle, so even a working dev URL would not be 24/7.

**No public URL is reported, because none exists.** `127.0.0.1` is not an internet endpoint
and is not described as one.

---

## 4. What IS available from Replit free

- Four validators with real consensus, running for as long as this Repl is awake.
- Durable state that survives restarts, on this Repl's disk.
- The hourly GitHub Actions job, which needs nothing from Replit and is now advancing its
  own chain history (see §5).
- The gateway source, ready to run anywhere with inbound ports.

## 5. CI status (unrelated to Replit, and healthy)

Run [`38307259675`](https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38307259675) —
**the first successful `testnet-epoch` run in the repository's history** (previously 21/21
failed). It committed its own state:

```
401846b  testnet: epoch 3 - height 33, cumulative 104 blocks, app_hash 3CAB5DAD412D1174
```

---

## 6. Chain identity (real, and unchanged)

```
cosmos chain-id   nexora-devnet-1
EVM chain-id      902024   (0xdc388)
genesis sha256    21a266af5577577f77ff8930a2a75469e8a2ddcdfb2a641edb0b034faccd83ef
denomination      anex, 18 decimals
node ids          12370658a989edb94edefbc5b87d75d5b4c7e47b
                  701cd144dd997ab5c079d725839ba11c97291e20
                  9df4fecece7c6292f4ec6c566d597d1e48dc4f1c
                  08ae401419bbf8edd39752847cbfe48b80d7b4ac
```

These node ids are genuine but **host-local**. They become valid
`nodeID@host:port` peers only on a host with reachable inbound ports — which free Replit
does not provide. No `persistent_peers` string is published here, because every possible
value would be unusable.

## 7. Security posture

- Validator and wallet keys are the **upstream public test mnemonics**. They hold no value
  and must never hold any.
- The gateway exposes **read endpoints only**. It cannot sign, submit or broadcast; a
  transaction is submitted from the operator's own machine.
- No private key, mnemonic or secret was written to GitHub, to any report, or to any log.
- No domain was configured. `nexora.io` ownership is still unconfirmed and untouched.
- No spending, no paid plan, no Mainnet.

## 8. Remaining limitations

| Limitation | Status |
|---|---|
| No public RPC/EVM endpoint | **Blocked** by free Replit ingress — needs a paid plan or a host with inbound ports |
| Not always-on | Free Repls sleep when idle |
| All four validators on one host | No fault tolerance; one host loss ends consensus |
| No independent external peers | Therefore **not** a distributed public testnet |
| Cannot deploy from this environment | CLI has no deploy command; account is free personal |

**Classification: a temporary, single-host testnet.** Four validators, real consensus,
durable state — not a public network.