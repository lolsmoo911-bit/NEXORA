# NEXORA — Mainnet Readiness Report

**Status: ASSESSMENT AND PREPARATION ONLY. NOTHING WAS LAUNCHED, PURCHASED, OR DEPLOYED.**

**Bottom line: NEXORA is NOT ready for Mainnet, and is not close.** The gaps are
structural, not cosmetic. Three of them are hard blockers that cannot be closed by writing
more code: no decided token economics, no distributed validator infrastructure, and no
security audit of anything.

Report date: 2026-10-13
Evidence commit: `f9a0a5d4863fd59973ebb60773c7e2764876026a` (origin/main, in sync with local)
Scope: assessment only. No approval is implied or requested by this document.

---

## 0. How to read this

Every claim below is tagged:

| Tag | Meaning |
|---|---|
| **[VERIFIED]** | I ran a command in this session and read the output. The command is shown. |
| **[STALE]** | A document on `main` that contradicts the current code/config. |
| **[ASSUMPTION]** | Something believed but not established by evidence. |
| **[UNKNOWN]** | Cannot be determined from inside this Repl. |

Anything not tagged **[VERIFIED]** is not evidence.

---

## 1. Audit — separating the three things

The user asked for these three to be kept distinct, because conflating them is how a
testnet demo gets mistaken for a product. They are genuinely three different things with
three different readiness levels.

### 1.1 The NEXORA native chain (`anex` / ANEX)

**[VERIFIED]** — chain parameters, from `chain/nexora-devnet.json` on `main`:

```
cosmos_chain_id : eip155:902024          <- TESTNET ID
evm_chain_id    : 902024                 <- TESTNET ID
bech32_prefix   : cosmos                 <- NOT unique to NEXORA
denom.base      : anex
denom.symbol    : ANEX
denom.display   : nex
denom.exponent  : 18
```

**[VERIFIED]** — genesis structure, from `testnet/genesis.json`:

```
genutil.gen_txs          : 4          (validators come from gentxs, not staking.validators)
staking.validators       : 0          (empty in genesis)
mint.params.inflation    : 0.13 initial, inflation_max 0.20
feemarket.params         : no_base_fee=false, base_fee=2 gwei, min_gas_price=1 gwei
bank.balances            : 5 accounts, pre-funded
```

**[VERIFIED]** — live chain behaves as testnet:

```
eth_chainId  : 0xdc388 = 902024
eth_gasPrice : 0x430e2340 = 1.13 gwei   (gas is NOT free)
```

**What this means:** `anex` is a *denomination on a testnet chain*. It is not a token with
a supply, an issuer, or a market. `docs/economics.md` says this explicitly and correctly:
"There is no token." That statement is the most accurate economic document in the repo.

**Configuration drift found.** `chain/nexora-devnet.json` records
`fees.min_gas_price: "0anex"`, while the genesis `feemarket` module records
`min_gas_price: 1000000000` (1 gwei). The runtime flag wins, and the live chain does charge
gas, so this is not currently exploitable — but it means the single source of truth for gas
pricing contradicts the value actually enforced. **[VERIFIED]** via `cast rpc eth_gasPrice`.

### 1.2 The GOLD/GLD vanity ERC-20

**[VERIFIED]** — deployed on NEXORA **Testnet**, EVM chain id 902024:

```
address       : 0xa9816d769cb64eccaba2ee093be619af474f4c44
suffix        : 474f4c44  (full ASCII hex of "GOLD")
deploy tx     : 0x07b20f3b393edcaff2d34f2a429aa7e58a8da99e61441a092b25eafc1df87917
block         : 9147, receipt status 0x1, 3464 bytes runtime code
name/symbol   : "GOLD" / "GLD", decimals 18, totalSupply 1e26
```

This is a **working ERC-20 on a testnet**. It has:

- no value, no liquidity venue, no market, no exchange listing
- no backing, no reserve, no redemption
- **no legal status whatsoever** — see §4.3
- no mainnet equivalent; deploying the same contract to mainnet would produce a
  *different address*, because the CREATE2 deployer address differs, so the mined salt and
  the whole 4-byte vanity search would have to be redone against the mainnet deployer

**[STALE]** — the CI run `38479155214` that is green proves: forge tests pass, the miner's
keccak matches Foundry, the cost arithmetic holds, and the deployment record is
self-consistent. It proves **nothing** about consensus safety, validator distribution,
key custody, or audit. A green unit-test suite is not a security audit.

### 1.3 Production infrastructure for NEXORA Mainnet

**[VERIFIED]** — this is where it fails hardest:

```
evmd processes on this machine : 4 (all validators)
hostname                       : repl
CPUs                           : 4
RAM                            : 7 GB
p2p external_address           : 127.0.0.1:26656     <- loopback only
listening                      : 26657/26659/26661/26663, 8545
```

**[VERIFIED]** — the four "validators" all run in one process group on one Repl instance,
talking to each other over `127.0.0.x`. There is no external P2P reachability at all.

**[VERIFIED]** — the chain died twice during this session and I had to restart it both
times from `testnet/restart.sh`. A network that stops when one host sleeps is not a network.

**BFT arithmetic, computed:**

| Configuration | Host failures tolerated |
|---|---|
| **4 validators, 1 host (CURRENT)** | **0** |
| 4 validators, 4 hosts | 3 |
| 5 validators, 5 hosts | 4 |
| 7 validators, 7 hosts | 6 |
| 13 validators, 7 hosts | 6 |

CometBFT requires **more than 2/3** of voting power online. Four validators on one host
means losing the host loses 100% of voting power. The current setup has a **single point
of failure and tolerates zero host failures**, regardless of the validator count.

---

## 2. Launch blockers — pass/fail with evidence

### 2.1 Token economics — **FAIL**

| Criterion | Status | Evidence |
|---|---|---|
| Supply model decided | **FAIL** | `docs/economics.md`: "no supply model" |
| Issuance schedule | **FAIL** | "no mint, burn, halving or staking-inflation policy" |
| Allocations (team/investors/treasury) | **FAIL** | "no allocation" |
| Vesting / unlock schedule | **FAIL** | "no vesting or unlock schedule" |
| Validator reward policy | **FAIL** | not defined anywhere |
| Fee policy (burn vs. validator vs. treasury) | **FAIL** | not defined; genesis charges 13% initial inflation with no destination |
| Utility | **FAIL** | ANEX is described only as "the native devnet token" |

**[VERIFIED]** `docs/economics.md` first line: **"NO DECISIONS HAVE BEEN MADE."**

Note: 13% initial inflation rising toward 20% is present in the genesis mint module. For a
token holding real value that is an extreme default, and there is no stated policy for
where it goes.

### 2.2 Production chain parameters — **FAIL**

| Criterion | Status | Evidence |
|---|---|---|
| Unique production chain ID | **FAIL** | only `902024` exists, and it is the testnet ID |
| Production genesis generation | **FAIL** | genesis generated by `ci/phase3/gen4-genesis.sh`, a CI script, from public test mnemonics |
| Native denomination | **PARTIAL** | `anex` is internally consistent, but `bech32_prefix` is `cosmos` — every Cosmos chain shows `cosmos1...` addresses, so an NEXORA address is indistinguishable at a glance from any other Cosmos chain |
| Wallet compatibility | **FAIL** | requires custom network config in every wallet; not listed in any wallet's chain registry |
| Validator key custody | **FAIL** | keys are upstream public test mnemonics (see 2.5) |

### 2.3 Independent validators — **FAIL**

| Criterion | Status | Evidence |
|---|---|---|
| Separate operators / legal entities | **FAIL** | all 4 run by one operator, in one account |
| Separate hosts | **FAIL** | 1 host, 4 processes |
| External P2P reachability | **FAIL** | `external_address = 127.0.0.1:26656` |
| Host-failure tolerance | **FAIL** | 0 |
| Quorum / fault-recovery tests | **PARTIAL** | `phase3-multinode-verify.yml` exists and passes, but it tests 4 processes on 1 machine — it cannot test host loss |
| Real geographic / provider diversity | **FAIL** | one Repl |

**[VERIFIED]** source: `ps aux`, `config.toml`, and the restart log showing all four
`evmd start` processes on `hostname = repl`.

### 2.4 Reliable infrastructure — **FAIL**

| Criterion | Status | Evidence |
|---|---|---|
| Persistent production storage | **PARTIAL** | testnet state persists on disk; there is no production storage design |
| Monitoring | **FAIL** | none exists |
| Alerting / on-call | **FAIL** | none |
| Snapshots | **FAIL** | no snapshot tooling found |
| Backups | **FAIL** | no backup tooling found |
| Recovery drills | **FAIL** | none performed; two unplanned restarts were survivable only because state is on local disk |
| Incident response doc | **FAIL** | none |

### 2.5 Security — **FAIL**

| Criterion | Status | Evidence |
|---|---|---|
| Independent audit — consensus/chain config | **FAIL** | **no audit record exists anywhere in the repository** |
| Independent audit — Solidity contracts | **FAIL** | **no audit record exists anywhere in the repository** |
| Critical/high findings remediated | **N/A** | no audit has been performed |
| Production key custody (HSM/KMS) | **FAIL** | see below |
| No test mnemonics on production | **FAIL** | see below |

**[VERIFIED]** — the validator/dev keys are recovered from upstream **public** test
mnemonics shipped in `cosmos-evm/local_node.sh`:

```
default_mnemonics=(
  "<public test mnemonic>" # dev0
  "<public test mnemonic>" # dev1
  "<public test mnemonic>" # dev2
  "<public test mnemonic>" # dev3
)
```

`ci/testnet/start-local-node.sh` itself says these "are published upstream and must never
hold value." They currently control 100% of the testnet's voting power. **These keys must
never touch mainnet.** Not reused, not "upgraded", not re-derived with a different path.

**[VERIFIED]** — no audit artifact: `git ls-tree -r origin/main | grep -iE
"audit|security|disclosure|bugbounty"` returns nothing.

External guidance consulted:
- [Cosmos validator security](https://docs.cosmos.network/hub/latest/validators/security) —
  consensus key protection via HSM (YubiHSM) or TMKMS, signing isolated from the node host.
- [Tendermint consensus spec](https://github.com/cometbft/cometbft/blob/main/spec/consensus/consensus.md)
  — progress requires >2/3 of voting power; under 1/3 honest, safety and liveness both break.
- [Tendermint validator docs](https://docs.tendermint.com/v0.34/tendermint-core/validators.html)
  — protecting the consensus key is the single most important factor in validator setup.

NEXORA currently meets none of these.

### 2.6 EVM contracts — **FAIL**

| Criterion | Status | Evidence |
|---|---|---|
| Reproducible builds | **PASS** | verified: clean rebuild reproduces the initcode hash `0x6447bb54…` byte-identically |
| Verified source/bytecode on explorer | **FAIL** | no production explorer; testnet verification not published |
| Deployment scripts | **PARTIAL** | manual `cast` invocations; `forge create` works, CREATE2 needs a factory call assembled by hand |
| Constructor arguments recorded | **PASS** | recorded in `deployments/vanity-testnet.json` |
| Ownership / governance | **FAIL** | none of the 7 contracts has any ownership or governance model |
| Deployment rehearsal | **PARTIAL** | testnet only |
| Upgradeability story | **FAIL** | not designed; the Create2Deployer immutability property is documented but not a production strategy |

**[VERIFIED]** contract inventory on `main` — 7 contracts, 979 lines, 70 passing tests:

```
AssetRegistry.sol        298    VanityAsset.sol     90
Create2Deployer.sol      111    LinearVesting.sol  135
TestSaleVault.sol        208    NexoraGreeter.sol   27
NexoraTestToken.sol      111
```

`NexoraGreeter.sol` is example code. Three of the seven are explicitly test-only. Shipping
that set to mainnet unchanged would be wrong.

### 2.7 Legal and brand — **FAIL**

| Criterion | Status | Evidence |
|---|---|---|
| Domain ownership | **FAIL** | `nexora.io` is registered at GoDaddy since 2024-08-05 under WHOIS privacy. **It is not owned by the project.** |
| Trademark review | **FAIL** | not started |
| Securities / token classification review | **FAIL** | not started |
| Terms of service / privacy policy | **FAIL** | not present in repo |
| Any public sale or marketing claim | **BLOCKED** | must not happen before the above |

**[VERIFIED]** prior investigation on this Repl: `nexora.io` parked apex, a deleted Framer
site, WHOIS privacy since 2024-08-05. Rebranding was deferred. Using this name publicly
before ownership is verified is a trademark-infringement risk against whoever does own it.

### 2.8 Documentation — **FAIL**

**[VERIFIED]** conflicts found on `main`:

| Conflict | Detail |
|---|---|
| **Denomination symbol** | `chain/nexora-devnet.json` says `ANEX`. `docs/economics.md` quotes `"symbol": "NEX"`. One of them is wrong. |
| **Economic status** | `docs/economics.md` says "There is no token / NO DECISIONS HAVE BEEN MADE", while `docs/testnet.md` and `docs/PUBLIC-ENDPOINTS.md` present a working chain with a named currency. |
| **Chain ID** | `902024` appears 34 times across `docs/` — all testnet — with no production ID anywhere and no doc stating that reuse is forbidden. |
| **Deployment guidance** | `docs/DEPLOYMENT-OPTIONS.md` and `docs/REPLIT-DEPLOYMENT.md` do not reference the vanity/CREATE2 approach at all. |
| **Vanity status** | `docs/VANITY-ADDRESSES.md` is current, but nothing cross-links it from the deployment docs. |
| **Gas pricing** | `chain/nexora-devnet.json` `min_gas_price: "0anex"` contradicts the enforced 1 gwei. |

---

## 3. Testnet preservation

**[VERIFIED]** the following are untouched and must stay labelled testnet:

- Chain `eip155:902024`, 4 validators, currently live at block >9,000
- Faucet `POST /api/nexora/faucet`, 100 ANEX default
- `0xa9816d769cb64eccaba2ee093be619af474f4c44` — GOLD/GLD, 4-byte vanity suffix
- `deployments/vanity-testnet.json`, `docs/VANITY-ADDRESSES.md`

Rules I will hold to, and have held to:

1. No testnet key, mnemonic, or balance is ever reused or migrated to a production chain.
2. The testnet genesis is **not** the production genesis. Production genesis is generated
   fresh from keys generated for production.
3. Chain id `902024` is retired for production; a new one is issued and reviewed.
4. Testnet tokens are never described as having value or being tradable. Every document
   that mentions GOLD/GLD says TESTNET ONLY.

---

## 4. Costed proposal

**NOTHING BELOW HAS BEEN PURCHASED, STARTED, OR SIGNED UP FOR.** Every figure is an
estimate for your approval. Your standing instruction is a $0 ceiling until you approve
something explicitly; this section exists so that approval can be informed.

### 4.1 Recommended architecture

**Minimum viable mainnet that survives one host loss and one operator being dishonest:**

| Role | Count | Placement |
|---|---|---|
| Validators | 7 | 7 independent hosts |
| Host distribution | 1 per host | deliberately one validator per host, so a host loss costs 1/7 |
| Operator count | ≥4 distinct entities | at least one must not be you |
| Sentry / non-validating full node | 2 | for monitoring and as a public RPC |
| Validator-set changes | threshold 2/7 | prevents one operator from unilateral control |

Why 7: with one validator per host, 7 tolerates 2 host losses (>5/7 = 0.714 > 2/3). With 5
it also tolerates 1, but 7 gives margin for one operator being unavailable *and* one host
lost. Why not 4: 4 tolerates exactly 1 host loss with zero margin.

Hardware per validator host: 4 vCPU / 8 GB RAM / 100 GB SSD is ample for a chain this
size; 2 vCPU / 4 GB / 80 GB is workable. Hardware is not the cost driver — operation is.

### 4.2 Mandatory costs

| Item | Basis | Monthly estimate |
|---|---|---|
| 7 validator hosts | 4 vCPU / 8 GB / 100 GB VPS, mixed providers | $280 – $560 |
| 2 sentry/RPC hosts | 2 vCPU / 4 GB / 80 GB | $40 – $80 |
| Object storage for snapshots | ~50 GB retained, daily | $2 – $5 |
| Monitoring (Uptime + metrics + logs) | free tiers suffice initially | $0 – $50 |
| Domain (a domain you actually own) | 1 yr | $10 – $15 /yr |
| **Mandatory subtotal** | | **≈ $332 – $710 /mo** |

One-time mandatory:

| Item | Estimate |
|---|---|
| Smart contract audit (2–3 firms, quotes needed) | $15,000 – $60,000 |
| Chain/consensus configuration review | $5,000 – $15,000 |
| Legal: token classification + securities opinion | $10,000 – $40,000 |
| Legal: entity formation, terms, trademark | $5,000 – $20,000 |
| **One-time mandatory subtotal** | **≈ $35,000 – $135,000** |

### 4.3 Optional costs

| Item | Estimate |
|---|---|
| Bug bounty (immunefi) | 5–10% of funds at risk, paid per finding |
| Second independent audit firm as cross-check | $10,000 – $25,000 |
| Formal verification of the token contract | $5,000 – $20,000 |
| Formal verification of the validator set logic | $10,000 – $30,000 |
| Key custody HSMs (YubiHSM 2 × FIPS, or cloud KMS) | $900 – $2,000 one-time |
| Liquidity / market-making | separate conversation, significant capital |
| Mainnet explorer (Blockscout self-hosted = free) | $0 |

**Do not buy any of this yet.** The audit and legal line items dominate and are
prerequisites; infrastructure should not be provisioned before they are underway, because
an audit finding will change the contracts and therefore the deployment.

### 4.4 Cost-aware alternative

If budget is the binding constraint, a defensible cheaper path exists and I would rather
say so than oversell:

- Launch **no token sale and no trading** initially. Publish the chain, the source, the
  explorer, and the validator set. This defers the entire securities question.
- Run **5 validator hosts** instead of 7 (tolerates 1 host loss; margin is thinner).
- Skip liquidity provision entirely.
- This cuts mandatory infra to roughly $220–420/mo and lets the legal and audit spend stay
  the dominant cost — which is correct, because that is where the risk is.

---

## 5. Blocking decisions you must make

These are yours, not mine. I cannot infer any of them.

1. **Is there a token at all?** A chain with a gas token is not a security. An investment
   contract is. This decision determines whether the $10k–$40k securities opinion applies,
   and it is irreversible in effect.
2. **Supply and allocation.** Total supply, team/investor/community split, lockups. Nobody
   can proceed without it.
3. **Inflation and fee policy.** Genesis carries 13%→20% inflation. Keep, cut, or fund
   differently? Where does it go — validators, burn, treasury?
4. **Validator set and operators.** Who are the 7, who holds the keys, who takes the
   uptime risk? At least one must not be you.
5. **Domain and name.** Do you own any NEXORA-named domain? If not, rebrand before any
   public use.
6. **Jurisdiction and entity.** Which entity issues, and under which law.
7. **Budget ceiling.** Which of §4.2/§4.3 is actually approved. This report assumes none.
8. **Go/no-go timing.** Genesis for a real chain is a one-shot, irreversible event.

---

## 6. Staged rollout and rollback

Genesis cannot be rolled back once real value exists. Rollback means *not starting*, or
restarting with a new chain id.

| Stage | Gate to proceed | Reversible? |
|---|---|---|
| 0. Economics + legal decided | Token classification opinion in hand | yes |
| 1. Contracts audited | All critical/high fixed and re-audited | yes |
| 2. Production infra | 7 hosts, monitoring, alerting, snapshots, a *rehearsed* restore | yes |
| 3. Public testnet ("NEXORA public testnet") | Testnet traffic, no value, no claims | yes |
| 4. Dry-run genesis | Rehearsal with production-shaped params, full restore drill | yes |
| 5. **Mainnet genesis** | All above green, explicit written approval | **NO** |
| 6. Soft launch | Chain live, no trading, 30-day soak | partially |
| 7. Public claims | Only after stages 0–6 and legal clearance | yes |

**Rollback before stage 5:** tear down, change nothing on chain, fix, rehearse again.
**Rollback after stage 5:** there is none for that chain id. Recovery is a new chain with a
new id and an explicit migration plan. This asymmetry is why stages 0–4 must be real, not
paperwork.

**Recovery drills required before stage 5, each with a written result:**
- kill one validator host; confirm the chain continues and alarms fire
- restore from snapshot onto a clean host; confirm `app_hash` continuity
- disk-full on a validator; confirm liveness
- full regional/provider outage; confirm remaining power holds 2/3
- lost signing key; confirm documented rotation path
- coordinator compromise rehearsal

---

## 7. Additional tests and audits required before launch

**Consensus and chain configuration**
- Fault injection across *real* hosts, not one machine — the existing phase3 CI cannot do this
- Mainnet genesis generation from production keys, rehearsed
- State sync from a cold peer, measured
- Catch-up and crash-recovery time objectives, measured
- Long-range attack / partition analysis for the chosen validator count
- Version skew and upgrade-coordination test

**Contracts**
- Independent audit by a firm with Cosmos-EVM experience (not a general Solidity shop only)
- Re-audit after any remediation
- Fuzzing and invariant tests on the sale vault and vesting contracts
- Gas-limit and DoS review under mempool pressure
- Formal verification of token supply accounting, if budget allows
- Deployment rehearsal on a production-shaped chain, from a clean clone, reproducibly

**Operational**
- Key rotation drill with real ceremony steps
- Restore-from-backup drill with measured RTO/RPO
- Alert-routing drill: page a human, confirm receipt
- Runbook review by someone who did not write it

---

## 8. Verification of this report's own claims

Reproduce the headline findings:

```bash
cd /home/runner/workspace/nexora-chain/NEXORA

# no audit exists
git ls-tree -r --name-only origin/main | grep -iE "audit|security|disclosure" || echo NONE

# economics undecided
git show origin/main:docs/economics.md | head -3

# symbol conflict
git show origin/main:chain/nexora-devnet.json | grep -A2 '"denom"'
git show origin/main:docs/economics.md | grep '"symbol"'

# public test mnemonics control all validators
grep -c 'default_mnemonics' ../cosmos-evm/local_node.sh

# all validators on one host, loopback only
ps aux | grep -c '[e]vmd'
grep external_address ../testnet/node0/config/config.toml

# chain id retired for production
git show origin/main:chain/nexora-devnet.json | grep evm_chain_id
```

---

## 9. Explicit statement

NEXORA is **not ready** for Mainnet. The passing CI run proves the code compiles, the tests
pass, and the vanity address is reproducible. It does not prove the project is safe to hold
value.

The three blockers that matter most are not code problems:

1. **No decided economics and no legal classification.** You cannot sell or market anything.
2. **No distributed infrastructure.** Four validators on one loopback-connected host
   tolerate zero host failures. There is no network yet.
3. **No audit of anything, and production keys are still public test mnemonics.**

I have not launched anything, purchased anything, registered anything, or changed billing,
and I will not until you approve a specific plan. Nothing in this report should be read as
having started work.