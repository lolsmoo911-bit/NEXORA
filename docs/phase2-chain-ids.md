# Phase 2 — Chain ID decision (devnet)

**Date of check:** 2026-10-10
**Status:** decided, applied to the devnet configuration in `chain/nexora-devnet.json`
**Owner decision:** Cosmos chain id `eip155:902024`; EVM chain id to be chosen after a
documented collision check; **do not reuse `262144`**.

## Decision

| Identifier | Value | Where it lives |
|---|---|---|
| Cosmos chain id | `eip155:902024` | `genesis.chain_id` (string, Cosmos SDK) |
| EVM chain id (EIP-155) | **902024** (`0xDC388`) | `app.toml [evm] evm-chain-id` and `evmd start --evm.evm-chain-id` |

The two identifiers are intentionally separate: the Cosmos chain id is a string used by the
SDK/CometBFT signing domain, while the EVM chain id is the EIP-155 replay-protection integer used
by the EVM and the JSON-RPC layer. Nothing requires them to be equal.

## Why 262144 must not be reused

While checking candidate values we found that **`262144` is already registered as a live public
chain** ("MPCQ Mainnet", `shortName: mpcq`, RPC `https://rpc.moneypoolscash.com`) in both data
sources below, and it is also the hardcoded upstream default
(`x/vm/types/params.go: DefaultEVMChainID uint64 = 262144`, `server/config/config.go`).
Reusing it would make NEXORA devnet transactions replayable against that chain's EVM domain, and
would make NEXORA indistinguishable from the unmodified reference chain we verified in Phase 1.

## Sources checked (and what "checked" means)

1. **chainid.network registry** — `https://chainid.network/chains.json`
   - fetched 2026-10-10; **2802 chain entries** parsed.
   - `262144` → present ("MPCQ Mainnet").
   - `902024` → **absent**.
2. **ethereum-lists/chains** — the upstream dataset that produces the registry above
   (`full_name: ethereum-lists/chains`, `pushed_at: 2026-10-10T12:28:31Z`, 9829 stars).
   - Per-chain file existence test:
     `https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/chains/eip155-<id>.json`
   - `eip155-902024.json` → **HTTP 404 (absent)**; control `eip155-11155111.json` → 200,
     `eip155-262144.json` → 200. So the 404 is a true absence, not a fetch failure.
3. **Neighbour check** — `902023` and `902025` are also absent from the registry, so the chosen id
   does not sit next to another registered chain id.

## Candidates evaluated

| Candidate | In chainid.network | In ethereum-lists | Decision |
|---|---|---|---|
| 262144 (upstream reference) | yes — MPCQ Mainnet | yes | rejected (owner + replay risk) |
| 90001 | yes — Pundi AIFX Omnilayer Testnet | — | rejected (taken) |
| 31338 | no | — | rejected (adjacent to the anvil default 31337) |
| 13370 / 4242 / 9999 / 3001 | yes (Cannon Testnet / Nexi Mainnet / myOwn Testnet / CENNZnet Nikau) | — | rejected (taken) |
| 420202 | no | — | rejected (inside the OP-stack devnet range) |
| 262145 | no | — | rejected (immediately adjacent to 262144 = MPCQ Mainnet) |
| **902024** | **no** | **no (404)** | **chosen** |
| 11155111 | yes — Ethereum Sepolia | yes | rejected (taken) |

## Honest limitations of this check

- Absence from these two public datasets is **not** proof of global uniqueness. A private,
  self-hosted or not-yet-registered chain could already use 902024, and anyone can deploy a chain
  with any number. This check therefore reduces collision risk; it does not eliminate it.
- A locally running devnet cannot be attacked by replay from another chain *unless* an attacker
  can get our node to accept a foreign signed transaction, i.e. the practical protection is the
  combination of (a) a chain id not in public use, and (b) not reusing the reference value.
- **Mandatory re-check before any public testnet or mainnet**: re-run both sources on the day the
  id is publicly announced and register the chain in the standard lists. This document is only
  valid for the devnet.

## Rollback

The chain ids live only in generated data (`genesis.json`, `app.toml`) produced by
`ci/phase2/genesis.sh` from `chain/nexora-devnet.json`. Rollback = delete those files (or revert
the commit that added them). The upstream reference repository is cloned fresh in CI and never
modified, so no upstream state has to be undone.
