# NEXORA Phase 2 Report — NEXORA devnet configuration

**Date:** 2026-10-10
**Status:** ✅ COMPLETE (all acceptance criteria met with recorded evidence)
**Final commit:** `b1740e2e14d763a60925aefa9806bf79198cb319`
**Successful run:** [#38071169448](https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38071169448) — `conclusion: success`
**Artifact:** `phase2-transcripts` (ID `11677196954`, 22247 bytes)
**Environment:** ephemeral GitHub Actions runner (ubuntu-24.04). Not mainnet, not a persistent public network. $0 cost.

---

## 1. Scope and constraints honoured

| Owner constraint | How it was honoured |
|---|---|
| Config/genesis scripts only, reversible | All changes live in `chain/nexora-devnet.json`, `ci/phase2/genesis.sh`, `ci/phase2/verify.sh`, and generated `genesis.json` / `app.toml`. Deleting these files fully reverts Phase 2. |
| No consensus / EVM engine changes | `cosmos/evm` is cloned fresh per run and **never modified**; the pinned SHA is asserted in CI. |
| No dependency version changes | Go `1.25.9` and upstream `v0.7.3` @ `c3ae9067a7eadcdea55a5192226916deb44c71c4` are unchanged from Phase 1. |
| Deterministic genesis, two independent runs, SHA256 compared | See §5. |
| `evmd validate-genesis`, node start, transfers, Solidity deploy | See §6, §7, §8. |
| Stop after documenting; no Phase 3, no public net, no mainnet, no AID/bridges | Phase 3 was not started. |

---

## 2. Chain identity (owner decisions)

| Identifier | Value | Source of truth |
|---|---|---|
| Cosmos chain id | `eip155:902024` | `genesis.chain_id` |
| EVM chain id (EIP-155) | **902024** (`0xdc388`) | `app.toml [evm] evm-chain-id` + `--evm.evm-chain-id` |

The two ids are deliberately separate (SDK string vs EIP-155 integer); nothing requires them to be equal.

**Collision check (full evidence and limitations): `docs/phase2-chain-ids.md`.**
Key facts: `262144` (the upstream reference value) is a **registered live public chain** — "MPCQ Mainnet" — in both `chainid.network` (2802 entries, fetched 2026-10-10) and `ethereum-lists/chains` (`eip155-262144.json` → HTTP 200). This confirms the owner's instruction not to reuse it.
`902024` is absent from `chainid.network`, `eip155-902024.json` returns **404** in `ethereum-lists/chains`, and its neighbours 902023/902025 are also unused. Absence from public lists reduces but does not eliminate collision risk; re-checking is mandatory before any public testnet.

---

## 3. Denomination: `anex`, 18 decimals, display `NEX`

Adopted as the **native base denom for both Cosmos SDK and EVM** (not EVM-only), per owner decision.

Genesis-level evidence (from the CI run):

```
evm_denom=anex
bond_denom=anex
mint_denom=anex
bank_metadata=base=anex display=nex exp=18 symbol=NEX
no stale upstream denoms (stake/atest/aphoton/uatom/aatom) found in genesis
```

- The display denom exponent is **18**, which is what `x/vm/keeper/coin_info.go: LoadEvmCoinInfo` reads to build the EVM coin info; for 18-decimal chains `extendedDenom == evmDenom == anex`.
- A recursive jq fixer rewrites **every** denom-bearing object (staking, mint, evm, gov deposits, crisis fee, fee pools, ERC-20 token pairs) — a final grep asserts no `stake`/`atest`/`aphoton`/`uatom`/`aatom` remains anywhere in genesis.
- The native ERC-20 representation (`0xEeeee…EEeE` token pair) uses `anex`, mirroring upstream `local_node.sh`.

**Known limitation (documented, not worked around):** the bech32 account prefix remains `cosmos`. Changing it is a code-level SDK change in the reference binary and is outside this config-only phase. It is recorded in `chain/nexora-devnet.json` (`bech32_note`) and should be scheduled as an explicit, separately-approved step before any public launch.

---

## 4. Fees

- `minimum-gas-prices = 0anex` (node floor), `--evm.min-tip 0`.
- Cosmos tx gas price: `2000000000anex` (2 gwei-equivalent).
- Measured on-chain: `eth_gasPrice = 0x2264aa57 = 577022551 anex/gas` in the first blocks, decaying from the feemarket's initial base fee of `1000000000.000000000000000000anex`.
- The script asserts the configured price clears the observed base fee before spending. An earlier attempt at `10000000anex` was correctly rejected by the node with `insufficient fee … required: 448795318.6anex`, which is exactly the fee market doing its job.

---

## 5. Deterministic genesis (two independent runs)

```
DETERMINISTIC: identical genesis bytes in two independent runs
sha256 = a04b29aaadf89a980b53f8d5420ecdf1e700c04204282e85da104533a00f00ae
```

- Run A and Run B execute in **separate CI steps, separate processes, separate homes** (`/tmp/nexora-a`, `/tmp/nexora-b`), each doing its own `evmd init`, key import, funding, `gentx`, `collect-gentxs` and `validate-genesis`.
- The files are compared with `sha256sum`, `cmp` (byte equality) and a sorted-key `jq` diff.
- Determinism required pinning three previously random inputs: `genesis_time`, and the gentx `--node-id` / `--ip` (the gentx memo defaults to `<node_id>@<ip>:26656`, and `node_key.json` is random per home).
- Dev/validator mnemonics are parsed **at runtime from the unmodified upstream `local_node.sh`** — no key material is stored in this repository.
- `evmd genesis validate-genesis` runs in both passes and succeeds.

---

## 6. Node start and JSON-RPC

```
JSON-RPC up after 2s
node network: eip155:902024
eth_chainId: 0xdc388          (902024)
net_version: 902024
chain identity OK (cosmos=eip155:902024, evm=902024)
blockNumber t0=0x1 t+3s=0x4
```

The script also asserts the chain id is **not** the upstream reference value `0x40000`.

---

## 7. Transfers

### Cosmos bank transfer (`anex`)
```
bank tx code: 0
dev0: 1000000000000000000000 -> 998769400000000000000
dev1: 1000000000000000000000 -> 1001230000000000000000 (expected +1230000000000000000)
```
Verified by exact big-integer comparison (python3), waiting for tx inclusion (`code == 0`) and for balances to settle.

### EVM transfer (wei of `anex`)
```
dev1 evm balance: 0x3646db8441905b0000 -> 0x36483ec9b9ede50000   (+100000000000000000)
EVM transfer OK
```

**Honest finding worth keeping:** the first attempt used `cast send <to> <amount>`, which under foundry 1.8.5 produced a transaction with **zero value** — it succeeded, consumed gas, but moved nothing, and the balance at blocks `0x8`, `0x9`, `0xa` and `latest` was unchanged. The script now detects this (it polls the balance and cross-checks the Cosmos bank view) and retries with an explicit `--value` flag, which works. Recorded rather than hidden; it is a client-side trap worth remembering for any future scripting against this chain.

---

## 8. Solidity contract

```
Compiler run successful!
Deployed to: 0x17cf225bEFBdC683A48DB215305552B3897906F6
greet() -> "Hello NEXORA"
code: 0x608060405234801561000f575f5ffd5b5060043610610034575f3560e01c8063a413686214610038…
```

The contract (`contracts/src/NexoraGreeter.sol`) is unchanged from Phase 1. Deploy attempts degrade typed → `--legacy` → no explicit `--chain-id`, so failures are diagnosed rather than silently swallowed.

---

## 9. Files added in Phase 2

| File | Purpose |
|---|---|
| `chain/nexora-devnet.json` | Single source of truth for every devnet parameter (chain ids, denom, decimals, fees, balances, genesis time). |
| `ci/phase2/genesis.sh` | Deterministic genesis generation + validation + node config. |
| `ci/phase2/verify.sh` | Starts the devnet and asserts identity, denom, fees, transfers, contract. |
| `.github/workflows/phase2-devnet-verify.yml` | CI: build pinned reference, two genesis runs, determinism check, verification, artifact upload. |
| `docs/phase2-chain-ids.md` | Chain id decision, collision-check sources, rejected candidates, honest limitations. |
| `docs/phase2-report.md` | This document. |

**Rollback:** revert the Phase 2 commits, or delete the files above. Nothing upstream, on-chain, or in any other environment needs undoing.

---

## 10. Acceptance criteria

- [x] Cosmos chain id `eip155:902024`, separate from the EVM chain id — verified via `evmd status` and `eth_chainId`.
- [x] EVM chain id chosen after a documented collision check; reference value `262144` not reused (it belongs to a registered public chain).
- [x] `anex` adopted as the native denom in both Cosmos and EVM, with 18-decimal metadata and no stale upstream denoms anywhere in genesis.
- [x] Fee parameters set and validated against the live feemarket base fee.
- [x] Genesis generated twice independently with identical SHA256; `evmd validate-genesis` passes.
- [x] Node produces blocks; bank transfer settles; EVM transfer settles.
- [x] Solidity contract builds, deploys, and `greet()` returns `Hello NEXORA`.
- [x] No consensus code changed; no dependency bumps; no public network; no mainnet; no AID/bridges.

**Conclusion: Phase 2 is COMPLETE by actual verification.**
