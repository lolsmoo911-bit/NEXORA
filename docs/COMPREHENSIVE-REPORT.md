# NEXORA — comprehensive project report

**Date: 2026-10-13 · Evidence commit: `b505935b68846db2c782e863e8cce6d8c3cfdcd0`**

**Status: TESTNET. NOT INVESTABLE. NOT READY FOR MAINNET.**

This document consolidates two prior reports — the vanity-address implementation report
and the mainnet readiness assessment — into one place, with the evidence for each claim and
an explicit statement of what is fact, what is assumption, and what is undecided.

**Nothing was launched, purchased, registered, or billed. This report describes work, not
progress toward a launch.**

**A note on evidence, because it is easy to over-read.** Where this report says a check
passes — 70 tests, 19 on-chain checks, three agreeing CREATE2 derivations — the claim is
exactly that and nothing more. Those are statements about arithmetic and about code matching
its specification. **No component of NEXORA has been security audited.** Arithmetic
correctness is not what keeps a chain safe, and a green CI run is the weakest available
evidence that this project is ready to hold value.

---

## 1. Verdict

Three sentences:

1. **The engineering works.** A real Cosmos EVM chain runs with four validators, real
   consensus, real P2P handshake, and real Solidity contracts including one deployed at a
   4-byte vanity address that reproduces bit-for-bit from a clean rebuild.
2. **The project is not a product.** There is no token, no economics decided, no security
   audit, no distributed validator set, no owned domain, and no legal position.
3. **The gap between those two statements is where all the risk lives.** A green CI run is
   the *weakest* possible evidence that a blockchain is safe to hold value, and this
   repository's own passing CI proves nothing about the three things that matter most.

---

## 2. The three layers — kept separate on purpose

Conflating these is how a testnet demonstration gets mistaken for a product. They are three
different things with three different readiness levels.

| | What it is | Readiness |
|---|---|---|
| **NEXORA chain** (`anex` / ANEX) | A Cosmos EVM L1 on unmodified `cosmos/evm` v0.7.3. Four validators, real consensus. | **Testnet.** Single host. |
| **Contracts** (GOLD/GLD + 6 more) | 7 Solidity contracts, 979 lines, 70 tests passing. Includes an ERC-20 at a vanity address. | **Testnet only. Unaudited.** |
| **Infrastructure** | One Replit instance running all four validators over loopback. Cloudflare Tunnel for public RPC. | **Not a network.** Zero host-failure tolerance. |

### 2.1 Chain facts

**VERIFIED** — from `chain/nexora-devnet.json`:

```
cosmos_chain_id : eip155:902024      TESTNET, retired for production
evm_chain_id    : 902024             same
bech32_prefix   : cosmos             NOT unique to NEXORA
denom           : anex / ANEX / 18   18 decimals forced by the upstream stack
```

**VERIFIED** — genesis (`testnet/genesis.json`):

```
genutil.gen_txs  : 4        validators come from gentxs, not staking.validators
staking.validators: 0       empty in genesis
mint inflation   : 13% initial, 20% ceiling, destination UNDECIDED
feemarket        : no_base_fee=false, base 2 gwei, floor 1 gwei
```

**VERIFIED** — live: `eth_chainId = 0xdc388`, `eth_gasPrice = 0x430e2340` (~1.1 gwei).
Gas is charged. It is not free.

### 2.2 Contract facts

**VERIFIED** — inventory on `main`:

| Contract | Lines | Purpose | Production-ready |
|---|---|---|---|
| `AssetRegistry.sol` | 298 | name → address, impersonation defence | no — unaudited, no governance |
| `TestSaleVault.sol` | 208 | sale simulation | **no — test-only** |
| `LinearVesting.sol` | 135 | cliff + linear vesting | no — unaudited |
| `NexoraTestToken.sol` | 111 | NXIT | **no — test-only** |
| `Create2Deployer.sol` | 111 | CREATE2 factory | no — unaudited |
| `VanityAsset.sol` | 90 | ERC-20 at a vanity address | no — unaudited |
| `NexoraGreeter.sol` | 27 | example | **no — delete before public release** |

No contract has an ownership model, a governance model, or an upgrade path. No contract has
been audited. No audit record exists anywhere in the repository.

### 2.3 Infrastructure facts — the hard failure

**VERIFIED**:

```
evmd processes      : 4 (all validators)
hostname            : repl
CPUs / RAM          : 4 / 7 GB
p2p external_address: 127.0.0.1:26656      loopback only, no external reachability
```

CometBFT requires **more than 2/3** of voting power online. Failure tolerance, computed:

| Configuration | Host failures tolerated |
|---|---|
| **4 validators, 1 host (current)** | **0** |
| 4 validators, 4 hosts | 3 |
| 5 validators, 5 hosts | 4 |
| 7 validators, 7 hosts | 6 |
| 13 validators, 7 hosts | 6 |

Four validators on one host tolerate **zero** host failures. The chain stopped twice during
this work and was restarted both times. This is a demonstration of consensus, not a network.

---

## 3. What was built — vanity addressing

### 3.1 The problem as originally posed

Make an asset name visible in its contract address:

```
GOLD -> 474f4c44 -> 0x......474f4c44
```

An EVM address is `keccak256(rlp([deployer, nonce]))[12:]`, so nobody chooses it. The
received answer was that this cannot be done. **That answer was incomplete**, and finding
out why produced the most useful result in this project.

### 3.2 Why it works — CREATE2

Steering a *plain* deployment means deploy, look, discard — millions of transactions. CREATE2
removes that entirely:

```
address = keccak256(0xff ++ deployer ++ salt ++ keccak256(initcode))[12:]
```

The salt is mixed in **before** the hash and we choose it. The entire search runs off-chain;
exactly **one** transaction is sent. Nothing is deployed and thrown away. The cost is CPU
time and nothing else.

### 3.3 Result — live on testnet

```
0xa9816d769cb64eccaba2ee093be619af474f4c44 └──────────┬──────────┘
                                                   474f4c44  =  GOLD
```

| | |
|---|---|
| Chain | NEXORA Testnet, EVM chain id **902024** |
| Deployer | `0x34b0c47A7aF2cD273b614aCACfd04251b89aDDE3` |
| Salt | `0x…076f3f70` |
| Initcode hash | `0x6447bb54ec9524614984fd569098dcefeb1d5ba2c4275fa4f109a99cf4d006d8` |
| Initcode | 5278 bytes, solc 0.8.33+commit.64118f21, optimizer off, evmVersion osaka |
| Deploy tx | `0x07b20f3b393edcaff2d34f2a429aa7e58a8da99e61441a092b25eafc1df87917` |
| Block / status | **9147**, receipt **`0x1`**, 3464 bytes runtime |
| Winning counter | 124,731,248 against a mean of 2³² = 4,294,967,296 (**0.029×**) |

**Three independent derivations agree**, all reproduced in CI:

| Method | Result |
|---|---|
| Miner's own keccak (`scripts/vanity.c`) | `0xa9816d769cb64eccaba2ee093be619af474f4c44` |
| Foundry `cast keccak` | `0xa9816d769cb64eccaba2ee093be619af474f4c44` |
| On-chain `computeAddress()` | `0xa9816d769CB64eCcAba2EE093BE619Af474F4C44` |

**Reproducibility, verified:** deleting `out/` and `cache/` and rebuilding from scratch
yields a byte-identical initcode and the identical hash. That is the strongest evidence
available short of re-running the 4-byte search.

### 3.4 Measured cost

From `python3 scripts/mining-cost.py`, which **measures** the hash rate rather than assuming
it:

| Suffix bytes | Hex digits | Expected attempts | Expected time |
|---|---|---|---|
| 3 | 6 | 16,777,216 | **3.6 s** |
| 4 | 8 | 4,294,967,296 | **15.4 min** |
| 5 | 10 | 1,099,511,627,776 | 2.7 days |
| 6 | 12 | 281,474,976,710,656 | **1.9 years** |

**4 bytes is the practical ceiling.** 5 bytes is days; 6 bytes is years. `SILVER`
(6 bytes, `53494c564552`) is not minable in full on this hardware.

### 3.5 Corrections made along the way

Recorded rather than quietly replaced, because each was a number somebody would have acted on.

| Error | Reality | How it was caught |
|---|---|---|
| 6-byte suffix quoted as "**250 years**" | 2⁴⁸/8.4e6 = **1.06 years**. The 250 followed from no formula. | Arithmetic review |
| Hash rate quoted as "**8.4M/s**", never measured | Measured: **1.41M/s** one thread, **4.26M/s** four | `vanity --bench` |
| `rho+pi` written as a parallel assignment with sequential tables | Wrong permutation; compiled, ran, printed wrong addresses | Foundry cross-check |
| 85-byte CREATE2 preimage read from a 53-byte array | Read 32 bytes past its own buffer every attempt | Foundry cross-check |
| Benchmark read `t0` in one function, `t1` in another | Reported 2593 s for a 2 s run | Reading the output |
| CREATE2 mints the ERC-20 supply to the **factory** | Tokens stranded; transfer from the factory reverts | Live deployment |

Two of these produced plausible-looking success. The keccak **vector test passed throughout**
— testing the hash function never tests the code that assembles its input. Only an
independent implementation caught them.

### 3.6 The operational cost that actually matters

Not CPU. A salt is valid for **one exact initcode hash**. Change one byte of the contract,
one constructor argument, or the compiler version, and the address is dead and the search
restarts. This happened live once, when constructor arguments were added after mining.

**Rule:** freeze the bytecode, record the initcode hash and compiler version beside every
salt, and treat the pair as one immutable artifact.

### 3.7 The second naming layer

`AssetRegistry` (`0x3e4a3Bebe3f2bE966c972bAeed974062cEc5CeC2`) maps human-readable names to
addresses durably — a registry entry can be re-pointed, a mined address cannot.

Its interesting property is impersonation defence. Confusable letters are **allowed**, because
`GOLD`, `SILVER` and `OIL` need O/I/L. Instead, `GOLD`, `G0LD` and `GO1D` share a
fingerprint, so `G0LD` cannot be registered while `GOLD` exists. The first implementation
banned those letters and was **case-inconsistent** — it rejected `gold` but accepted `GOLD`,
handing an impersonator the spelling nobody defends. The tests caught it.

---

## 4. Mainnet blockers

Every item is **FAIL** unless marked otherwise. Evidence is a command that reproduces it.

| # | Blocker | Status | Evidence |
|---|---|---|---|
| 1 | **Supply model** | FAIL | `docs/economics.md`: "no supply model" |
| 2 | **Issuance schedule** | FAIL | 13%→20% inflation is an upstream default, not a decision |
| 3 | **Allocations** | FAIL | "no allocation" — no team/investor/treasury split |
| 4 | **Vesting** | FAIL | "no vesting or unlock schedule" |
| 5 | **Fee destination** | FAIL | Every fee burned is itself undecided |
| 6 | **Production chain ID** | FAIL | Only `902024` exists, and it is the testnet ID |
| 7 | **Production genesis** | FAIL | Generated by a CI script from **public test mnemonics** |
| 8 | **Denomination uniqueness** | PARTIAL | `anex` consistent, but `bech32_prefix = cosmos` — visually identical to any Cosmos chain |
| 9 | **Wallet compatibility** | FAIL | Custom network config everywhere; no registry listing |
| 10 | **Independent validators** | FAIL | 4 processes, 1 host, 1 operator, loopback |
| 11 | **Host-failure tolerance** | FAIL | **0** |
| 12 | **Real fault-injection tests** | FAIL | `phase3` CI tests 4 processes on 1 machine — cannot test host loss |
| 13 | **Monitoring / alerting** | FAIL | None exists |
| 14 | **Snapshots / backups** | FAIL | None exists |
| 15 | **Recovery drills** | FAIL | Two unplanned restarts survivable only via local disk |
| 16 | **Incident response** | FAIL | No document |
| 17 | **Chain security audit** | **FAIL** | **No audit record exists in the repository** |
| 18 | **Contract security audit** | **FAIL** | **No audit record exists in the repository** |
| 19 | **Production key custody** | FAIL | Upstream public mnemonics; no HSM/KMS |
| 20 | **Contract ownership/governance** | FAIL | No ownership model on any of 7 contracts |
| 21 | **Domain ownership** | FAIL | `nexora.io` registered elsewhere, WHOIS privacy, **not this project's** |
| 22 | **Trademark / securities review** | FAIL | Not started |
| 23 | **Terms / privacy** | FAIL | Absent |
| 24 | **Public sale or claims** | BLOCKED | Must not precede 1–23 |

### 4.1 The key finding

**VERIFIED** — the validator keys are recovered from upstream **public test mnemonics** in
`cosmos-evm/local_node.sh`. The repository's own start script states they "are published
upstream and must never hold value." They currently control 100% of testnet voting power.

These must never touch mainnet — not reused, not upgraded, not re-derived by a different path.

### 4.2 External guidance applied

- [Cosmos validator security](https://docs.cosmos.network/hub/latest/validators/security) —
  consensus key protection via HSM (YubiHSM) or TMKMS, signing isolated from the node host.
- [CometBFT consensus spec](https://github.com/cometbft/cometbft/blob/main/spec/consensus/consensus.md)
  — progress requires >2/3 voting power; safety and liveness both depend on it.
- [Tendermint validator docs](https://docs.tendermint.com/v0.34/tendermint-core/validators.html)
  — consensus key protection is the single most important validator-setup factor.

NEXORA currently meets none of these. **A passing unit-test suite is not a substitute for an
audit**, and this repository's green CI demonstrates only the former.

---

## 5. Costed proposal

**Nothing below has been purchased, started, or signed up for.** Estimates only. The standing
instruction is a $0 ceiling until you approve something explicitly.

### 5.1 Architecture — minimum that survives one host loss

| Role | Count | Notes |
|---|---|---|
| Validators | 7 | one per host, so a host loss costs 1/7 |
| Independent operators | ≥4 distinct | at least one must not be you |
| Sentry / public RPC | 2 | non-validating |
| Validator-set change threshold | 2/7 | prevents unilateral control |

Hardware per host: 4 vCPU / 8 GB / 100 GB SSD is ample; 2 vCPU / 4 GB / 80 GB works. Hardware
is not the cost driver — operations are.

### 5.2 Mandatory

| Item | Estimate |
|---|---|
| 7 validator hosts | $280 – $560 /mo |
| 2 sentry/RPC hosts | $40 – $80 /mo |
| Snapshot storage (~50 GB retained) | $2 – $5 /mo |
| Monitoring (free tiers suffice initially) | $0 – $50 /mo |
| **Infrastructure subtotal** | **≈ $332 – $710 /mo** |
| Contract audit (2–3 firms) | $15,000 – $60,000 |
| Chain/consensus configuration review | $5,000 – $15,000 |
| Legal: token classification opinion | $10,000 – $40,000 |
| Legal: entity, terms, trademark | $5,000 – $20,000 |
| **One-time subtotal** | **≈ $35,000 – $135,000** |

**The one-time figure dominates, and that is correct** — that is where the risk is.

### 5.3 Optional

Bug bounty (5–10% of funds at risk) · second audit firm ($10k–25k) · formal verification of
token supply accounting ($5k–20k) · formal verification of validator-set logic ($10k–30k) ·
HSMs ($900–2,000 one-time) · liquidity provision (separate, significant capital) · explorer
(self-hosted Blockscout: $0).

Do not provision infrastructure before audits are underway — a finding will change the
contracts and therefore the deployment.

### 5.4 Cheaper path, if budget binds

Publish the chain, the source, the explorer and the validator set — **no token sale, no
trading**. This defers the entire securities question. Run 5 validator hosts instead of 7
(tolerates 1 host loss; thinner margin). Skip liquidity. Infrastructure drops to roughly
**$220 – $420 /mo** while audit and legal remain the dominant spend, which is where it should
be.

---

## 6. Decisions that are yours

None can be inferred. None has been made.

1. **Is there a token at all?** A chain with a gas token is not a security; an investment
   contract is. Determines whether the securities opinion applies. Largely irreversible.
2. **Supply and allocation.** Nobody proceeds without it.
3. **Inflation and fee policy.** Keep, cut, or fund differently? Where does it go?
4. **Validator set and operators.** Who are the 7? Who holds keys? Who carries uptime risk?
5. **Domain and name.** Do you own any NEXORA-named domain? If not, rebrand before any
   public use.
6. **Jurisdiction and issuing entity.**
7. **Budget ceiling.** Which of §5.2/§5.3 is approved. This report assumes none.
8. **Timing.** Genesis is a one-shot, irreversible event.

---

## 7. Staged rollout

Genesis cannot be rolled back once real value exists. "Rollback" before that means *not
starting*; after it means a new chain ID and a migration plan.

| Stage | Gate | Reversible |
|---|---|---|
| 0 | Economics + legal decided, classification opinion in hand | yes |
| 1 | Contracts audited; all critical/high fixed and re-audited | yes |
| 2 | Production infra live: 7 hosts, monitoring, alerting, snapshots, **a rehearsed restore** | yes |
| 3 | Public testnet under production-shaped parameters, no value, no claims | yes |
| 4 | Dry-run genesis with production keys + full restore drill | yes |
| 5 | **Mainnet genesis** — explicit written approval | **NO** |
| 6 | Soft launch, no trading, 30-day soak | partially |
| 7 | Public claims — only after 0–6 and legal clearance | yes |

**Drills required before stage 5, each with a written result:** kill one validator host and
confirm liveness plus alarms · restore from snapshot onto a clean host and confirm `app_hash`
continuity · fill a validator's disk · simulate full provider/region outage · lose a signing
key and execute the documented rotation · rehearse coordinator compromise.

---

## 8. What remains to be done

**Consensus / chain**
- Fault injection across **real** hosts — the existing CI structurally cannot do this
- Production genesis from production keys, rehearsed
- State sync from a cold peer, measured; crash-recovery time objectives, measured
- Long-range attack / partition analysis for the chosen validator count
- Version-skew and multi-operator upgrade coordination

**Contracts**
- Independent audit by a firm with **Cosmos-EVM** experience, not general Solidity only
- Re-audit after remediation
- Fuzzing and invariants on the sale vault and vesting contracts
- DoS review under mempool pressure
- Formal verification of supply accounting if budget allows
- Clean-clone deployment rehearsal, reproducibly

**Operational**
- Key rotation drill with real ceremony steps
- Restore drill with measured RTO/RPO
- Alert-routing drill: page a human, confirm receipt
- Runbook review by someone who did not write it

---

## 9. Reproducing this report's headline claims

```bash
cd /home/runner/workspace/nexora-chain/NEXORA

# no audit exists anywhere
git ls-tree -r --name-only origin/main | grep -iE "audit|security|disclosure" || echo NONE

# economics undecided, while genesis inflation is 13%->20%
git show origin/main:docs/economics.md | head -3
python3 -c "import json;print(json.load(open('../testnet/genesis.json'))['app_state']['mint']['params'])"

# public test mnemonics control all four validators
sed -n '/default_mnemonics=(/,/)/p' ../cosmos-evm/local_node.sh

# all validators on one host, loopback only, zero host-failure tolerance
ps aux | grep -c '[e]vmd'
grep external_address ../testnet/node0/config/config.toml

# vanity address derivation, three ways
python3 scripts/verify-vanity.py --label "FULL GOLD vanity target (4 bytes)"

# measured hash rate and cost table
python3 scripts/mining-cost.py
python3 scripts/mining-cost.py --check
```

---

## 10. Explicit closing statement

NEXORA is **not ready** for mainnet. The passing CI run proves the code compiles, the tests
pass, and the vanity address reproduces bit-for-bit from a clean rebuild. It does not prove
the project is safe to hold value.

The three blockers that matter most are not code problems:

1. **No decided economics and no legal classification.** Nothing can be sold or marketed.
2. **No distributed infrastructure.** Four validators on one loopback host tolerate zero host
   failures. There is no network yet.
3. **No audit of anything, and production keys are still public test mnemonics.**

The strongest asset in this project is the fact that the vanity address reproduces
byte-for-byte from a clean checkout, verified three independent ways. The weakest fact is
that every one of those verification paths is a statement about arithmetic, and arithmetic is
not what keeps a chain safe.

Nothing has been launched, purchased, registered, or billed, and nothing will be until a
specific plan is explicitly approved.