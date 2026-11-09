# Chain ID: `eip155:902024`

The Cosmos chain-id is **`eip155:902024`** — EIP-155 format, matching the numeric EVM
chain ID `902024` (`0xdc388`).

## Why

EIP-155 is the format every major EVM chain uses:

| Chain | `network` in `/status` |
|---|---|
| Ethereum | `eip155:1` |
| BSC | `eip155:56` |
| Polygon | `eip155:137` |
| Arbitrum | `eip155:42161` |
| Avalanche | `eip155:43114` |
| Base | `eip155:8453` |
| **NEXORA** | **`eip155:902024`** |

Wallets, explorers and indexers that pattern-match `eip155:<id>` recognise this immediately.
The previous `nexora-devnet-1` was a plain string that no EVM-aware tool would associate with
chain `902024`, which is a real interoperability weakness for anything downstream.

## What changed

| | Before | After |
|---|---|---|
| `cosmos_chain_id` | `nexora-devnet-1` | `eip155:902024` |
| Genesis sha256 | `21a266af5577577f77ff8930a2a75469e8a2ddcdfb2a641edb0b034faccd83ef` | `33d94dd053106f0666f21a526c4addd8660c833cb2d0465f63cb90beeca4d847` |
| `eth_chainId` | `0xdc388` | `0xdc388` (unchanged) |
| Wallet configuration | unchanged | unchanged |

**The EVM chain ID did not change.** Wallets configured with `902024` / `0xdc388` need no
edit. Only the Cosmos-side chain-id string differs, which is what `/status` reports under
`network` and what a Cosmos wallet would show.

## This reset the chain

Changing the chain-id regenerates genesis, which changes the chain hash. All prior state was
invalid, so the network restarted from height 1. Validator keys are unchanged (they derive
from the fixed upstream mnemonics), so balances are back to their genesis allocation.

`testnet/ledger.json` still carries `"network": "nexora-devnet-1"` for epochs recorded under
the old id. That is intentional history, not a stale reference — the next CI epoch will
write `eip155:902024`.

## Files that carry the id

| File | Purpose |
|---|---|
| `chain/nexora-devnet.json` | single source of truth (`cosmos_chain_id`) |
| `ci/testnet/run-epoch.sh` | the `network` field written into the ledger |
| `scripts/nexora-proxy-express.ts` | the chain block served by `/api/nexora/info` |
| `scripts/nexora-rpc-gateway.mjs` | the standalone gateway banner |

Changing it again means editing the JSON first; every other location follows from it.

> ## ⚠️ 902024 is TESTNET ONLY and is RETIRED for production
>
> **Added 2026-10-13.** This file documents the testnet chain id. It must never be reused
> for a NEXORA production network, and the testnet genesis must never be the production
> genesis.
>
> Reasons, so the rule is not just asserted:
>
> 1. `902024` is already baked into genesis, into 34 references across `docs/`, into
>    wallets and explorers that have cached it, and into every transaction hash that
>    exists. Reusing it means an old testnet transaction could be replayed as a
>    production transaction.
> 2. The testnet validator keys are upstream **public test mnemonics**. Production must
>    begin from keys generated for production.
> 3. Production needs its own, reviewed, uniquely-registered identifier. That identifier
>    does not exist yet, and choosing it is a decision, not a default.

See `docs/MAINNET-READINESS-REPORT.md` section 2.2.

---

Current state of the project: **`docs/STATUS.md`**.
