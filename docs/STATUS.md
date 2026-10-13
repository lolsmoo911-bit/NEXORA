# NEXORA — current status

**Single source of truth. Updated 2026-10-13 at commit `f9a0a5d`.**

If any other document disagrees with this page about what currently exists, this page is
right and the other one is stale.

---

## Read this first

NEXORA is a **testnet project**. It is not a cryptocurrency, not investable, not tradeable,
and not ready for mainnet. The honest summary is:

> A Cosmos EVM chain that runs, with test-only contracts, all on **one machine**. No
> economics have been decided, no security audit has been done, and the validator keys are
> still public test mnemonics.

See `docs/COMPREHENSIVE-REPORT.md` for the full consolidated assessment with
evidence, and `docs/MAINNET-READINESS-REPORT.md` for the detailed blocker matrix.

---

## What exists

| Thing | State | Evidence |
|---|---|---|
| **Chain** | Running. Cosmos EVM, `cosmos/evm` v0.7.3 **unmodified**, 4 validators | `ci/testnet/phase3-multinode-verify.yml` |
| **Chain ID** | `eip155:902024` — **TESTNET, retired for production** | `chain/nexora-devnet.json` |
| **Denomination** | `anex`, 18 decimals, ticker `ANEX` | `chain/nexora-devnet.json` |
| **Consensus** | Real, 4 validators, ~1.3 s blocks | testnet running at block >9,000 |
| **Gas** | Charged, ~1.1 gwei. **Not free** | `cast rpc eth_gasPrice` → `0x430e2340` |
| **Public RPC** | Live via Cloudflare Tunnel, **ephemeral** | `docs/PUBLIC-ENDPOINTS.md` |
| **Faucet** | Live, 100 ANEX default, rate-limited | `POST /api/nexora/faucet` |
| **Contracts** | 7 Solidity, 70 tests passing | CI run `38479155214` |
| **GOLD vanity token** | Deployed, 4-byte suffix `474f4c44` | `0xa9816d769cb64eccaba2ee093be619af474f4c44` |
| **Asset registry** | Deployed | `0x3e4a3Bebe3f2bE966c972bAeed974062cEc5CeC2` |
| **Sale + vesting simulation** | Deployed and exercised | `docs/SALE-ROUND-2-RESULTS.md` |

## What does not exist

- **No token.** `anex` is a denomination string. No supply model, no allocation, no vesting,
  no issuance policy. `docs/economics.md` says "NO DECISIONS HAVE BEEN MADE" and means it.
- **No audit.** Not of the chain, not of the contracts. Nothing in this repository records one.
- **No distribution.** All 4 validators run as processes on **one** host over loopback.
  That tolerates **zero** host failures. CometBFT needs >2/3 of voting power online.
- **No production keys.** The validator keys are upstream **public test mnemonics** from
  `cosmos-evm/local_node.sh`. The repo's own start script says they must never hold value.
- **No owned domain.** `nexora.io` is registered elsewhere and is **not** this project's.
- **No economic decisions.** Genesis carries 13% initial inflation rising to 20% with no
  stated destination. It is an upstream default, not a choice.
- **No mainnet.** Not planned beyond the readiness report. Do not read any testnet artifact
  as mainnet-ready.

---

## The three things that are easy to confuse

| | What it is | What it is NOT |
|---|---|---|
| **`anex` / ANEX** | A denomination on a testnet chain, used for gas | A token. It has no supply, no price, no issuer. |
| **GOLD / GLD** | An ERC-20 on **this testnet**, at a vanity address | An asset, a reserve, a commodity, anything with value |
| **CI green** | Code compiles, tests pass, vanity is reproducible | Proof that the chain is safe or production-ready |

---

## Contract inventory

7 contracts, 979 lines, 70 tests. Three are explicitly test-only and must never be
published to a public network as-is.

| Contract | Lines | Purpose | Production-ready? |
|---|---|---|---|
| `AssetRegistry.sol` | 298 | name → address, impersonation defence | no — needs audit, no governance |
| `TestSaleVault.sol` | 208 | sale simulation | **no — explicitly test-only** |
| `LinearVesting.sol` | 135 | cliff + linear vesting | no — needs audit |
| `NexoraTestToken.sol` | 111 | NXIT test token | **no — explicitly test-only** |
| `Create2Deployer.sol` | 111 | CREATE2 factory | no — needs audit |
| `VanityAsset.sol` | 90 | ERC-20 at a vanity address | no — needs audit |
| `NexoraGreeter.sol` | 27 | example code | **no — delete before any public release** |

None of these has an ownership model, a governance model, or an upgrade path.

---

## Live testnet addresses

**TESTNET ONLY. No value. Not tradable.**

| What | Address |
|---|---|
| GOLD/GLD (4-byte vanity `474f4c44`) | `0xa9816d769cb64eccaba2ee093be619af474f4c44` |
| CREATE2 factory (current) | `0x34b0c47A7aF2cD273b614aCACfd04251b89aDDE3` |
| CREATE2 factory (legacy, no `deployAndCall`) | `0x61028fc00e7283Cf0Af586B6462d1671C28B6797` |
| Asset registry | `0x3e4a3Bebe3f2bE966c972bAeed974062cEc5CeC2` |

Full record with salts, initcode hashes and receipts: `deployments/vanity-testnet.json`.
Verify anything on chain:

```bash
python3 scripts/verify-vanity.py            # 19 checks
python3 scripts/verify-vanity.py --transfer --key-file <key> --to <other>   # 24
```

---

## Where the detail lives

| Question | File |
|---|---|
| **Full consolidated picture** | **`docs/COMPREHENSIVE-REPORT.md`** |
| Is this ready for mainnet? | `docs/MAINNET-READINESS-REPORT.md` |
| How does vanity addressing work? | `docs/VANITY-ADDRESSES.md` |
| What are the assets called? | `docs/ASSET-NAMING-SYSTEM.md` |
| What does the chain ID mean? | `docs/CHAIN-ID.md` |
| Where is the public RPC? | `docs/PUBLIC-ENDPOINTS.md` |
| What has and has not been decided economically? | `docs/economics.md` |
| What are the known threats? | `THREAT_MODEL.md` |
| What is the plan? | `ROADMAP.md` |

---

## Corrections log

Documents get fixed. These are the changes, so a reader can tell a deliberate correction
from an error that was never noticed.

| Date | Change |
|---|---|
| 2026-10-13 | `economics.md` quoted `"symbol": "NEX"`; authoritative value is `ANEX`. Corrected, with a note that `nex` is a display abbreviation only. |
| 2026-10-13 | `chain/nexora-devnet.json` recorded `min_gas_price: 0anex` while the genesis `feemarket` module enforced 1 gwei. The params file was wrong and permitted free transactions on paper. Corrected to `1anex`. |
| 2026-10-13 | README claimed "there is no live network" and "there is no public RPC". Both were true when written and are now false — a local testnet node and a Cloudflare Tunnel endpoint have existed since. Corrected to describe the single-host reality rather than claiming nothing runs. |
| 2026-10-13 | README did not mention the vanity address work or the asset registry at all, despite both being deployed and verified. Added. |
| 2026-10-13 | `DEPLOYMENT-OPTIONS.md` and `REPLIT-DEPLOYMENT.md` did not mention CREATE2 or vanity addressing. Added, and cross-linked. |
| 2026-10-13 | `PUBLIC-ENDPOINTS.md` documented a `janeway.replit.dev` URL that no longer resolves. Replaced with the current Cloudflare Tunnel endpoint and a warning that the URL is ephemeral and dies when the Repl sleeps. |
| 2026-10-13 | `docs/CHAIN-ID.md` did not state that `902024` is retired for production. Added explicitly. |