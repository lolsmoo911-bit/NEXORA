# End-to-end sale simulation — executed on the NEXORA testnet

**TESTNET ONLY. Unaudited. Nothing here has monetary value.** Real transactions on a real
chain — the arithmetic is simulated, the execution is not.

Date: 2026-10-13 · chain `eip155:902024` · EVM `902024` (`0xdc388`)

---

## Contracts deployed

| | Address |
|---|---|
| `NexoraTestToken` (NXTT) | `0x7673cE09B30e758d68F0ab707e0DAf6e0E180748` |
| `TestSaleVault` | `0x3BF5b9b163662DFf052e5E5B632b0DbB9A1A66Be` |
| Deployer / treasury | `0x7cB61D4117AE31a12E393a1Cfa3BaC666481D02E` |

Token supply: **1,000,000,000 NXTT**, all minted to the deployer at construction.
500,000 NXTT deposited into the vault.

## Sale terms

| Parameter | Value |
|---|---|
| Price per NXTT | **0.05 ANEX** (`50000000000000000` wei) |
| Hard cap | 1,000,000 NXTT |
| Max per address | 10,000 NXTT |
| Window | open − 60s … +30 days |

---

## Results

| Step | Outcome |
|---|---|
| buyer1 buys 1,000 NXTT | `status 1` · **1,000 NXTT delivered** · paid 50 ANEX |
| buyer2 buys 2,500 NXTT | `status 1` · **2,500 NXTT delivered** · paid 125 ANEX |
| buyer2 tries 8,000 more | **reverted `ExceedsPerAddress`** — cap enforced on-chain |

### Final state

```
sold          4,500 NXTT
raised          225 ANEX
remaining  995,500 NXTT of cap
```

The vault's arithmetic is internally consistent: 4,500 × 0.05 = **225 ANEX** exactly.

### Receipt — status 0x1

```json
{"status":"0x1","blockNumber":"0x5cf","gasUsed":96697,
 "effectiveGasPrice":1000000001,"logs":[…2 events…]}
```

| | |
|---|---|
| Block | 1487 |
| Gas used | 96,697 |
| Effective gas price | 1,000,000,001 wei |
| **Fee paid** | **0.000096697 ANEX** |

Two Transfer events: vault → buyer, and the test currency movement. Gas is **non-zero**,
which it was not before the feemarket floor fix.

### The public endpoint returns this receipt

```
POST https://…trycloudflare.com/api/nexora/evm
  {"jsonrpc":"2.0","method":"eth_getTransactionReceipt","params":["0x6b027d2e…"]}
→ {"result":{"blockNumber":"0x5cf",…}}
```

This resolves the gap recorded earlier: `eth_getTransactionReceipt` returns nothing for
Cosmos bank transactions, but it **does** work for genuine EVM transactions. That is exactly
the path a wallet uses, so a wallet send will show a proper receipt.

---

## Reproducing it

```bash
export ETH_RPC_URL=http://127.0.0.1:8545
TOKEN=0x7673cE09B30e758d68F0ab707e0DAf6e0E180748
VAULT=0x3BF5b9b163662DFf052e5E5B632b0DbB9A1A66Be

# deposit inventory
cast send $TOKEN "approve(address,uint256)" $VAULT $MAX_UINT --private-key $DEPLOYER
cast send $TOKEN "transfer(address,uint256)" $VAULT 500000000000000000000000 --private-key $DEPLOYER

# buy
cast send $VAULT "buy(uint256)" 1000000000000000000000 --value 50ether --private-key $BUYER

# inspect
cast call $VAULT "sold()(uint256)"
cast call $VAULT "raisedTotal()(uint256)"
cast call $VAULT "costOf(uint256)(uint256)" 1000000000000000000000
cast receipt <txhash>
```

`forge` has no `forge call` in v1.5 — use `cast call`.

---

## Two things worth knowing

**`forge create --json` printed nothing usable** on this chain; the plain form worked. And
`cast` prints values like `500000000000000000000000 [5e23]`, which breaks naive `int()`.
Strip the bracketed annotation.

**Keys.** Every account here is either a well-known public test key from the upstream
mnemonic, or a throwaway generated for this run and discarded. No private key was printed,
committed, or written to a report.

---

## What this does not prove

- Not audited. The owner key is a plain EOA with no multisig or timelock.
- Not mainnet-ready. No KYC/AML, no geofencing, no vesting, no reentrancy review.
- The vault has a `refundAll` whose proportional refund is computed but unused — it sweeps to
  treasury and leaves the per-buyer accounting to an off-chain report. That is a simulation
  shortcut and should not survive into anything real.
- Single host, free tier, sleeps when idle.

## Before any real sale

1. Rebrand — `nexora.io` is **not yours**.
2. Entity, jurisdiction, securities opinion.
3. Multisig + timelock on the owner key.
4. KYC/AML and geofencing.
5. Independent audit.
6. Vesting and unlock schedule.

None of those are optional, and none of them are code.