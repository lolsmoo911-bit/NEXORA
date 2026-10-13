# NEXORA — domain & server deployment options

Status: **planning only.** Nothing paid has been created. No Mainnet. No domain
purchased or modified. Awaiting the owner's decision.

Last updated: 2026-10-12 · chain-id `eip155:902024` · EVM chain-id `902024`

---

## 0a. Replit free: tested, and it cannot host a public endpoint

A free Replit deployment was attempted and measured. **The chain runs; the public endpoint
does not exist.** Replit ingress returns `502 "We couldn't reach this app"` for a purpose-built
RPC gateway *and* for the Repl's own pre-existing app on port 8080. The account is
`REPL_ORG_TYPE=PERSONAL` (free), and the `replit` CLI here has no deploy command. Free Repls
also sleep when idle.

Full evidence, including what *does* work (four validators, consensus, restart survival,
transfers): **`docs/REPLIT-DEPLOYMENT.md`**.

Consequence: Option A and Option B both still require a host with inbound ports. Neither can
be delivered on free Replit.

---

## 0. Baseline: CI now passes for the first time

Run [`38307259675`](https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38307259675)
finished **green** — every step including `Run one epoch` — and committed its own state:

```
401846b  testnet: epoch 3 - height 33, cumulative 104 blocks, app_hash 3CAB5DAD412D1174
```

```
epoch 1  h35  431EB99AD649C09343  tx C1144A32D06B
epoch 2  h36  796E11CEC8C22E75B3  tx 8734575F3B0A
epoch 3  h33  3CAB5DAD412D1174B9  tx 7B5F7172EE2C
```

Previously **21 of 21 runs failed**. The hourly job is now genuinely advancing a chain
with continuous history.

---

## 1. Domain — `nexora.io` already exists, ownership unconfirmed

```
nexora.io   REGISTERED
  registrar      GoDaddy.com, LLC
  registrant     Domains By Proxy, LLC      ← WHOIS privacy, owner hidden
  registered     2024-08-05
  expires        2027-08-05
  nameservers    ns55/ns56.domaincontrol.com
  lock           clientTransferProhibited (normal registrar lock)
```

Current DNS:

| Record | Value | Meaning |
|---|---|---|
| `nexora.io` A | `13.248.243.5`, `52.223.52.2`, `35.71.142.77`, `76.223.105.230` | **GoDaddy parking IPs** — not a real site |
| `www.nexora.io` | CNAME → `sites.framer.app` → **"Site Not Found"** | Framer site was configured, now deleted |
| MX / TXT | none | no mail, no verification records |

### ⚠️ Action required before anything public

**Check your GoDaddy account: does `nexora.io` appear there?**

- **Yes** → you own it; DNS can be pointed anywhere.
- **No** → the exact brand has been held by someone else since August 2024. For a token
  project this is serious: you would be launching under a domain you cannot control, and
  anyone can build on that name. Resolve this before any public launch.

### Alternatives if the name is unavailable

`.io` is among the most expensive TLDs — roughly **$40–70/year at renewal** (registrars
often show ~$11 the first year, then reprice). Verify before buying.

| Candidate | Rough cost/yr | Note |
|---|---|---|
| `nexora.xyz` | $12–20 | cheap, widely accepted |
| `nexora.network` | $25–40 | semantically apt |
| `nexora.dev` | $15–25 | forces HTTPS |
| `getnexora.io` | same as `.io` | fallback |

### Proposed DNS plan — nothing applied

```
rpc.nexora.io    A  <server-ip>    Cosmos CometBFT RPC   :26657
evm.nexora.io    A  <server-ip>    EVM JSON-RPC          :8545
ws.nexora.io     A  <server-ip>    WebSocket             :8546
api.nexora.io    A  <server-ip>    REST, only if enabled :1317
seed.nexora.io   A  <seed-ip>      seed / persistent peer:26656
```

---

## 2. Three server options

Costs are **ballparks for planning — verify at checkout.**

### Option A — Public Testnet ⭐ recommended

A real network reachable from your phone, with genuine validator infrastructure.

| | |
|---|---|
| Architecture | 1 server, 4 validators (proven: 4/4 agreement, voting power 4000) |
| Minimum spec | 4 GB RAM, 2 vCPU, 40 GB SSD. Four validators currently occupy 60 MB. |
| Cost | **~$4–6/month** — Hetzner CPX11 ~€3.79 · Contabo ~€4.50 · Vultr $5 · Lightsail $3.50 |
| Genuinely free? | Only **Oracle Cloud Always-Free** (4 ARM / 24 GB). Real, but signup is frequently blocked by capacity errors and Oracle may reclaim idle instances. Do not plan around it. |
| Stronger variant | 4 × cheapest = **~$15–17/month**, one validator per host. Survives one machine dying without halving the chain. |
| Testable | Every RPC call from your phone; wallet connection; test transfers; real latency; validator count and uptime from an outside observer. |
| Domain cost | + ~$40–70/yr if `.io` unavailable |
| Risks | Single IP = easy DDoS. Public RPC attracts abuse and scanning (bandwidth bills). You hold the validator keys. |

### Option B — Private remote testnet

Same machine, reachable **only by you**.

| | |
|---|---|
| Architecture | 1 server, 4 validators, ports firewalled to your IP only |
| Access | **Tailscale free tier** or WireGuard — no open ports at all; device appears as `100.x.y.z` |
| Cost | **~$4–6/month**. Tailscale **$0**. Domain not needed. |
| Genuinely free? | Server no. Private tunnel **yes** — Tailscale personal tier is free. |
| Testable | Everything in Option A, but only from your own devices. You prove it works *for you*, not for the public. |
| Risks | Lowest. You cannot claim "anyone can connect". |

**How you would test it:** install Tailscale → the server appears as `100.x.y.z` → point
MetaMask/Rabby at `http://100.x.y.z:8545`, add custom network `902024` (`0xdc388`).
Height / transfer / balance via the curl commands in §4.

### Option C — Mainnet

**Planning only. Will not be launched without explicit approval.**

| | |
|---|---|
| Architecture | 4+ validators across **4 independent operators, 4 hosting providers, 4 regions**. Never 4 on one box. |
| Infrastructure | ~$60–200/month |
| Security audit | **$10,000–50,000+** — non-optional for held value |
| Legal | Trademark, securities review, entity, jurisdiction: **$5,000–30,000+** |
| Key custody | HSM or KMS. Never a plain file. Documented key ceremony. |
| Realistic total | **$25,000–100,000+** plus ongoing |
| Blockers | Domain ownership (§1). Economic parameters undecided — `docs/economics.md` is deliberately empty. No legal entity. No audit. |

---

## 3. Connection addresses — pending deployment

**No public address exists yet, and none is invented here.** Addresses are reported only
after an option is approved, deployed, and tested **from outside the server**.

Real and current:

```
chain-id          eip155:902024
EVM chain-id      902024   (0xdc388)
genesis sha256    33d94dd053106f0666f21a526c4addd8660c833cb2d0465f63cb90beeca4d847
denomination      anex, 18 decimals (forced by upstream cosmos/evm v0.7.3)
local node IDs    12370658…  701cd144…  9df4fece…  08ae4014…
```

Those node IDs are genuine but **machine-local**. They become valid
`nodeID@host:port` persistent peers only once the nodes run on a server with a public IP.
A fabricated `nodeID@203.0.113.5:26656` would be a fake address.

---

## 4. Security posture

- Validator keys are the **upstream public test mnemonics**. Published upstream. They must
  never hold value, and never will.
- No private keys, mnemonics or secrets reach GitHub. A credential scan runs over every
  commit before push; all four pushes so far scanned clean.
- Management ports stay closed. Option B exposes nothing to the internet at all.
- Testnet and Mainnet remain fully separate: different chains, genesis, keys, servers and
  data directories.
- Restart survival, state persistence, inter-validator consensus, transfers and fees are
  already tested — see `docs/network-verification.md`.

### Command set to be supplied on deployment

Ready-to-run commands for block height, validator set, a test transfer, balance and
transaction result — each executed against the deployed endpoint from an external host, with
output pasted into the deployment report.

---

## 5. Decisions required

1. **Do you own `nexora.io`?** Check the GoDaddy account. Blocks everything public.
2. **Option A, B or C?**
3. If A or B: which provider, and **4 validators on one machine (~$4/mo)** or
   **4 separate machines (~$17/mo)**?

---

## Asset naming: two approaches, both deployed on testnet

*Added 2026-10-13. This section did not exist; the vanity work was documented only in
`docs/VANITY-ADDRESSES.md` and was invisible from the deployment docs.*

NEXORA has two distinct naming mechanisms. They are not alternatives to each other — they
solve different problems and the recommendation is to use **both**.

> **Neither mechanism has been security audited.** Passing tests are not an audit. See
> `docs/STATUS.md`.

### 1. AssetRegistry — the durable layer

Human-readable name → address. `resolve("GOLD")` returns an address.

- survives redeployment, because a name in a contract can be re-pointed
- case-folded, ASCII-only, first-come-first-served, never overwritable
- blocks impersonation structurally: `GOLD`, `G0LD` and `GO1D` share a fingerprint, so
  `G0LD` cannot be registered while `GOLD` exists
- source: `contracts/src/AssetRegistry.sol`

### 2. CREATE2 vanity address — the cosmetic layer

The asset name is ASCII-hex-encoded into the tail of the contract address:

```
GOLD -> 474f4c44 -> 0x...474f4c44
```

This **can** be done, contrary to the common assumption that it cannot:

```
address = keccak256(0xff ++ deployer ++ salt ++ keccak256(initcode))[12:]
```

The salt is chosen before the hash, so the search runs off-chain and exactly **one**
transaction is sent. Nothing is deployed and discarded.

Live on testnet: `0xa9816d769cb64eccaba2ee093be619af474f4c44`.

### The operational cost that decides everything

A salt is valid for **one exact initcode hash**. Change one byte of the contract, one
constructor argument, or the compiler version, and the address is dead and the search
restarts. Measured cost of a 4-byte suffix: ~15 minutes on 4 cores. A 6-byte suffix is
~1.9 years and is not practical.

So: **freeze the bytecode, record the initcode hash and compiler version next to every
salt, and treat the pair as one immutable artifact.**

### Deploying one

```bash
gcc -O3 -march=native -fopenmp -o scripts/vanity scripts/vanity.c

# 1. freeze the initcode, record its hash
python3 scripts/mining-cost.py           # measure the hash rate, print the cost table

# 2. mine a salt for a target suffix
./scripts/vanity <deployer> <initcodeHash> 474f4c44

# 3. deploy through the factory
cast send <factory> "deployAndCall(bytes32,bytes,bytes)(address)" \
  <salt> <initcode> <forward-call> --private-key <key> --legacy

# 4. verify independently, never trust the miner
python3 scripts/verify-vanity.py --label "<label>" --transfer --key-file <key> --to <other>
```

Note `deployAndCall`, not `deploy`. CREATE2 makes the **factory** `msg.sender` inside the
constructor, so a standard ERC-20 mints its whole supply to the factory, which cannot call
anything — the tokens are stranded. This was observed live. `deployAndCall` forwards the
supply in the same transaction and leaves no standing authority afterwards.

Full detail, including three bugs that produced plausible but wrong addresses:
`docs/VANITY-ADDRESSES.md`.
