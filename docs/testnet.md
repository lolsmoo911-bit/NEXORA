# NEXORA testnet

Two different things share the name "testnet". This document says which is which, because
collapsing them is how a project ends up claiming a network it does not have.

---

## 1. The CI epoch network — automatic, free, not always on

`.github/workflows/testnet-epoch.yml` runs hourly. Each run is one **epoch**:

1. Restores the previous epoch's application state from `testnet/state.json`.
2. Starts **four validators** on separate loopback addresses.
3. Runs them to consensus and waits for the target height.
4. Checks that all four hold an **identical `app_hash`**.
5. Submits a real `bank send`, waits for it to be **included in a block**, and asserts the
   recipient's balance moved by exactly the transferred amount.
6. Exports the new application state and commits `testnet/` back to the branch.

### Why it is built this way

GitHub Actions runners are **ephemeral**, and GitHub is not a server host. A node started in
a job dies when the job ends. So the network is split deliberately:

| Dies with the job | Survives the job |
|---|---|
| node processes | `testnet/state.json` — the application state |
| CometBFT data directories | `testnet/ledger.json` — the history |
| the P2P mesh | |

The chain therefore has **one continuous history** across epochs even though no process
outlives a job. This is state sync's idea, with git as the archive.

### What this is NOT

- **No live RPC endpoint.** Nothing answers requests between epochs. A wallet cannot connect.
- **No block-height continuity.** CometBFT restarts at height 1 each epoch because the genesis
  is re-seeded. Only *application state* carries — balances, sequences, contract storage. The
  ledger records cumulative blocks and per-epoch height separately; adding them would be a
  category error.
- **Not a public network.** Not reachable from the internet, by design.

### Growth

`state.json` is committed every hour and grows as accounts and contracts accumulate. At a
few accounts it is a few hundred KB. This is fine for months and **will not be fine
indefinitely** — when it gets large enough, the answer is periodic state pruning or an
external archive, not a bigger git repository.

---

## 2. The local network — yours, 24/7, free

```bash
bash ci/testnet/start-local-node.sh
```

Four validators, real consensus, real P2P, running until you stop them. Your machine is the
infrastructure: no server bill, no account, no third party.

```bash
curl -s http://127.0.0.1:26652/status | head -c 400
bash ci/testnet/stop.sh
```

Requires Linux or macOS (WSL2 counts), 4 GB RAM free, ~2 GB disk, Go 1.25.9, and `jq`.

**This is the only genuinely live NEXORA network that exists, and it is not running until you
run it.** That is not a limitation of the tooling; it is the honest boundary of a $0 project
with no operator.

### Why there is no public RPC here

Opening a port is a security decision with a real threat model: rate limiting, TLS, key
rotation, patching cadence, abuse. It is not a decision an automated agent should make on
your behalf, and shipping an unauthenticated public RPC would be a vulnerability, not a
feature.

---

## 3. The coin

**There is no coin.** `anex` is a denomination in `chain/nexora-devnet.json`, written into
genesis accounts. It has:

- no contract
- no supply model, issuance schedule or allocation
- no price, liquidity or market
- no legal or brand review

The balance that moves during an epoch is **test tokens** from public upstream test mnemonics.
They are published in the upstream repository and must never hold value.

---

## 4. What is actually verified

| Claim | Verified by |
|---|---|
| 4 validators reach consensus with identical app hashes | every epoch, asserted |
| a real transaction settles and balances move | every epoch, asserted |
| state carries across epochs | the ledger's appHash chain |
| upstream source is unmodified | commit-hash check before every build |
| genesis is deterministic | byte-identical across independent runs |

| NOT verified | |
|---|---|
| availability between epochs | there is none |
| behaviour under real network partitions | single machine, loopback only |
| Byzantine or adversarial conditions | untested |
| any production property whatsoever | no audit exists |
