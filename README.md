# NEXORA

An EVM-compatible Layer 1 built on unmodified open-source components, with a **market
simulation core** for pricing fixed-income instruments.

**Read this first.** This project is not a cryptocurrency, not a running network, and not
investable. It is a verified foundation plus a tested pricing library. Section 2 says exactly
what exists and section 8 says what does not. Nothing below is aspirational — every claim
marked *verified* has a CI run behind it.

---

## 1. What this is

Three separate pieces, built in this order:

| Piece | What it is | State |
|---|---|---|
| **The chain** | A Cosmos EVM chain, four validators, built on **unmodified** `cosmos/evm` v0.7.3 | Verified in CI |
| **AID** | A deterministic identifier scheme for assets, with two independent implementations that agree on every test vector | Verified in CI |
| **Market core** | Fixed-income pricing: day counts, coupon schedules, yield, DV01, convexity | Verified in CI, 41 tests |

They are related but independent. The chain needs instrument identity, which is what AID
provides. The market core is pure arithmetic and needs neither.

---

## 2. What this is NOT

This section is not a disclaimer. It is the most important part of this file.

- **There is no coin.** `anex` is a denomination string in a config file. It has no contract,
  no supply model, no issuance schedule, no allocation, and no price. See `docs/economics.md`
  for what a token would need and what has not been decided.
- **There is no live network.** GitHub Actions runners are ephemeral and GitHub is not a
  server host. Every run of the chain is destroyed when its job ends. To get a node that is
  actually up, run `ci/testnet/start-local-node.sh` on a machine you control — that is free
  and genuinely 24/7, and it is the only live NEXORA network that has ever existed.
- **There is no public RPC.** Opening a port is a security decision with a threat model, and
  it is not a decision an automated agent should make on your behalf.
- **There is no security audit.** The upstream project has its own audit history; it covers
  the July-2025 codebase state (≈v0.3.x), roughly fourteen months before the pinned v0.7.3,
  and it covers nothing NEXORA-specific. See `docs/architecture-decision-record.md`.
- **A green CI run is not a security result and not production readiness.**

---

## 3. The chain

Built on Apache-2.0 components, pinned:

| Layer | Choice | Pin |
|---|---|---|
| EVM framework | `cosmos/evm` | v0.7.3 @ `c3ae9067a7eadcdea55a5192226916deb44c71c4` |
| Consensus | CometBFT | v0.39.3 (inherited) |
| Chain stack | Cosmos SDK | v0.54.3 (inherited) |

**Upstream source has never been modified.** Every workflow re-checks the commit hash before
building, and a mismatch fails the job.

### Verified by execution

- Four validators reach consensus with an **identical application hash** at the same height.
- Killing one validator does **not** halt the chain: 13 further blocks were produced by the
  remaining three.
- A killed validator **re-syncs** to the network tip when restarted.
- Genesis is **byte-for-byte reproducible** across independent runs.
- A real `bank send` settles and the recipient's balance moves by exactly the amount sent.

Run: [#38179431126](https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38179431126) ·
report: [`docs/phase3-report.md`](docs/phase3-report.md)

### The testnet

`ci/testnet/run-epoch.sh` runs one **epoch**: it restores the previous epoch's application
state, runs four validators to consensus, settles a transfer, and commits the new state back
to this branch. The chain therefore has one continuous history across epochs even though no
process outlives a job.

```bash
# CI, hourly — see .github/workflows/testnet-epoch.yml
gh workflow run testnet-epoch.yml

# On your own machine, four real validators until you stop them
bash ci/testnet/start-local-node.sh
curl -s http://127.0.0.1:26657/status | head -c 400
```

### The public endpoint

Four validators also run on a free Replit workspace, reachable over its public dev domain:

```bash
BASE=https://<repl-dev-domain>/api/nexora

curl -s -X POST $BASE/evm -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
# -> {"result":"0xdc388"}   (902024)

curl -s $BASE/cosmos/status      # block height, app_hash, catching_up
curl -s $BASE/info               # chain ids, denom, genesis sha256, the public URLs

# `listen_addr` shows 127.0.0.1 — that is correct and must stay that way.
# The container is behind NAT; the gateway is the only public surface.
# docs/ADDRESSES.md explains why changing it would break the four-node mesh.
```

Built entirely from the files in this repository. Setup, including the two-line `app.ts`
change that publishes it: **`docs/SETUP-PUBLIC-ENDPOINT.md`**. Verified externally, not
locally: **`docs/PUBLIC-ENDPOINTS.md`**.

It is a **single-host testnet** and it is **not always-on** — a free Replit sleeps when idle.
bash ci/testnet/stop.sh
```

Details, including exactly what "an epoch" does and does not mean:
[`docs/testnet.md`](docs/testnet.md).

---

## 4. AID — asset identity

A scheme for naming assets deterministically:

```
assetId = keccak256(0xA1 || domainSeparator || assetType || assetKey)
domainSeparator = keccak256(abi.encode(chainId, specVersion))
```

Specification: [`aid/SPEC.md`](aid/SPEC.md). There are **two independent implementations** —
`aid/src/aid.mjs` and `aid/src/Aid.sol` — asserted against the same seven test vectors. A
specification enforced by one codebase asserting its own correctness is not a specification.

Also included: `AidRegistry.sol` (metadata is re-hashed and checked against the identifier it
is filed under; first claim wins; retraction is final) and `AidFactory.sol` (CREATE2, with the
collision guard that stops a second deployment silently returning the *existing* contract).

Run: [#38245177000](https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38245177000) ·
reports: [`docs/phase4-report.md`](docs/phase4-report.md), [`docs/phase5-report.md`](docs/phase5-report.md)

---

## 5. Market simulation core

Fixed-income pricing in `market/`. Pure functions, explicit arguments, no clock and no
network in the pricing path — which is what makes it testable against values derived by
hand.

```js
import { dirtyPrice, accruedInterest, sensitivities, dv01 } from './market/src/bond.mjs';

const bond = {
  face: 100, couponRate: 0.06, frequency: 2,
  maturity: '2030-06-15', dayCount: '30/360 US',
};

dirtyPrice(bond, 0.06, '2020-06-15');   // 100.000000 — a par bond, exactly
accruedInterest(bond, '2020-09-15');    // 1.5      — exactly half a coupon
dv01(bond, 0.06, '2020-06-15');         // ~0.0369
```

Implemented: ACT/365F, ACT/360, 30/360 US, 30E/360; coupon schedules; accrued interest; yield
implied by price; modified duration, DV01, convexity.

**Not implemented, deliberately:** ACT/ACT and ACT/ACT ICMA — which is the US Treasury
convention. The code *refuses* them rather than approximating. Pricing a Treasury on 365
instead would be a basis point wrong on every coupon, and the result would look entirely
normal. This is the single most important known gap.

Run: [#38251218610](https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38251218610) — 41/41.

---

## 6. Repository map

```
chain/          NEXORA devnet parameters — the single source of truth for chain ids and denom
ci/phase2/      deterministic genesis
ci/phase3/      four-validator network, fault tolerance, recovery
ci/testnet/     epoch runner, local 24/7 node, stop script
market/         pricing core: src/daycount.mjs, src/bond.mjs, test/
aid/            SPEC.md, JS + Solidity implementations, registry, factory, vectors
contracts/      a greeter used to prove Solidity deployment works on the chain
bridge/         least-privilege MCP server for agent-to-agent coordination
docs/           phase reports, architecture decision record, threat model, testnet notes
```

---

## 7. Running the tests

Every claim above is reproducible. Nothing requires credentials or spending money.

```bash
# fixed-income core — no network, no chain
cd market && node --test test/*.test.mjs

# AID: both implementations against the same vectors
cd aid && npm install && forge test -vv && node --test test/*.test.mjs

# the chain — clones and builds upstream, takes a few minutes
gh workflow run testnet-epoch.yml
```

---

## 8. Known limits

| Limit | Detail |
|---|---|
| No live network | runners are ephemeral; see section 2 |
| No token | `docs/economics.md` lists what is undecided |
| ACT/ACT not implemented | the Treasury convention; refused rather than approximated |
| No audit | upstream audit predates the pinned release by ~14 months |
| Single machine | no multi-machine partition testing, no Byzantine conditions |
| Untested on the real chain | the registry and factory have only run under Foundry's EVM |

Two risks are tracked and deliberately left open: the **Release Family 2026.1 gap** and
**long-term upstream dependency support**. Both are noted in `chain/upstream.md`.

---

## 9. Documents

- [`ROADMAP.md`](ROADMAP.md) — phases, deliverables and exit criteria
- [`SPEC.md`](SPEC.md) — master specification
- [`THREAT_MODEL.md`](THREAT_MODEL.md)
- [`aid/SPEC.md`](aid/SPEC.md) — the AID specification, with its known gaps
- [`docs/architecture-decision-record.md`](docs/architecture-decision-record.md) — why this baseline
- [`docs/testnet.md`](docs/testnet.md) — what "live" means here, and what it does not
- [`docs/economics.md`](docs/economics.md) — what a token would require; **nothing is decided**
- [`docs/phase3-report.md`](docs/phase3-report.md), `phase4`, `phase5` — evidence, including the defects each phase found

**Running and reaching the network**

- [`docs/PUBLIC-ENDPOINTS.md`](docs/PUBLIC-ENDPOINTS.md) — the live endpoints, verified externally, with limits
- [`docs/SETUP-PUBLIC-ENDPOINT.md`](docs/SETUP-PUBLIC-ENDPOINT.md) — how to rebuild the public endpoint from this repo
- [`docs/WALLET-SETUP.md`](docs/WALLET-SETUP.md) — adding NEXORA Testnet to Trust Wallet or MetaMask on Android
- [`docs/ENDPOINT-VERIFICATION.md`](docs/ENDPOINT-VERIFICATION.md) — the endpoint test matrix, executed against the live URL
- [`docs/ADDRESSES.md`](docs/ADDRESSES.md) — why `listen_addr` shows loopback, and where the public URL lives
- [`docs/CHAIN-ID.md`](docs/CHAIN-ID.md) — why the chain is `eip155:902024`, and what changed
- [`docs/COMMANDS.md`](docs/COMMANDS.md) — copy/paste commands for height, validators, transfers, fees
- [`docs/REPLIT-DEPLOYMENT.md`](docs/REPLIT-DEPLOYMENT.md) — the Replit deployment and what it does not support
- [`docs/network-verification.md`](docs/network-verification.md) — measured chain evidence
- [`docs/DEPLOYMENT-OPTIONS.md`](docs/DEPLOYMENT-OPTIONS.md) — domain findings and server options, **planning only**

---

## 10. Licence and provenance

Everything is built on permissively licensed open-source components: Apache-2.0
(`cosmos/evm`, Cosmos SDK, CometBFT) and LGPL-3.0 (the Cosmos fork of go-ethereum, inherited).
**The upstream reference chain has never been patched.**
