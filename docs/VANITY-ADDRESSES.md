# Vanity Addresses — hex-suffix deployment on NEXORA

**TESTNET ONLY. The token deployed here has no value and is not officially tradable.**
This is the Hex Encoding + Vanity Generation approach. It works. This document records
what was measured, what was deployed, and what is still pending.

---

## 1. Current status — read this first

| Item | State |
|---|---|
| 3-byte suffix `474f4c` ("GOL") | **DEPLOYED and VERIFIED**, two deployments |
| Full 4-byte `474f4c44` ("GOLD") | **NOT YET MINED.** Search running |
| Miner, tests, verification script | **COMPLETE** |

The full `GOLD` target is **not** complete. No salt exists for it yet, nothing is deployed
at such an address, and this document does not claim otherwise. Section 7 is its status
record and will be updated only when a salt exists and has been verified.

---

## 2. Why this is affordable at all: CREATE2

Vanity mining is normally absurd, because steering a plain deployment address means
**deploy, look, and discard** — one transaction per attempt, and millions for a 4-byte
suffix.

CREATE2 removes the cost:

```
address = keccak256(0xff ++ deployer ++ salt ++ keccak256(initcode))[12:]
```

The salt is mixed in *before* the hash and we choose it, so the entire search runs off-chain
and exactly **one** transaction is sent. Nothing is deployed and thrown away. The cost is
CPU time and nothing else.

One consequence is easy to miss: CREATE2 is an **opcode**, not a transaction type. A wallet
cannot execute it directly, so the `deployer` in the formula must be a contract. That is what
`Create2Deployer` is for.

---

## 3. What was built

| File | Purpose |
|---|---|
| `scripts/vanity.c` | CREATE2 miner, OpenMP, `--bench` for measured rate |
| `scripts/mining-cost.py` | measures the rate, prints the cost table, asserts the arithmetic |
| `scripts/verify-vanity.py` | independent on-chain verification, optional live transfer |
| `contracts/src/vanityAsset.sol` | minimal ERC-20 that lands on the vanity address |
| `contracts/src/Create2Deployer.sol` | the permanent CREATE2 factory |
| `contracts/test/VanityAsset.t.sol` | 12 tests |
| `deployments/vanity-testnet.json` | machine-readable record; the single source of truth |

```bash
gcc -O3 -march=native -fopenmp -o scripts/vanity scripts/vanity.c
python3 scripts/mining-cost.py            # measure rate, print cost table
python3 scripts/mining-cost.py --check    # assert the arithmetic
python3 scripts/verify-vanity.py          # verify what is deployed
```

---

## 4. Corrections

Two published numbers in the previous version of this document were wrong. Both are recorded
here rather than quietly replaced, because the second one is the same class of error as the
first.

### 4.1 The 6-byte search time was arithmetically wrong

The earlier document said a 12-hex-digit suffix such as `SILVER` (`53494c564552`) would take
**"about 250 years"**.

```
2^48 / 8.4e6 = 33,508,926 s = 388 days = 1.06 years
```

**1.06 years, not 250.** The 250 did not follow from any formula in the document.

### 4.2 The 8.4M/s rate was never measured

The 1.06 years above is correct *at 8.4M/s*, but 8.4M/s was a guess. Measured on this
4-core machine with `vanity --bench`:

```
1 thread   1.406 M/s
4 threads  4.264 M/s      <- this is the real figure
```

So the true cost of a 6-byte suffix here is **~1.9 years**, not 250 and not 1.06. Both
published numbers were wrong; the honest one is the measured one.

`mining-cost.py` now measures the rate by default instead of taking it on trust, and
`--check` asserts the identities (`2**(8n) == 256**n`, each byte costs 256x the last) so a
regression is loud.

### 4.3 Three miner bugs that produced plausible, wrong output

A miner that returns bad addresses is worse than one that crashes, because it looks like
success.

1. **`rho+pi` written as a parallel assignment** with the sequential `RHO`/`PI` tables.
   Compiled, ran, printed addresses — all wrong. Caught only by comparing against `cast keccak`.
2. **Buffer overrun.** The CREATE2 preimage is 85 bytes (`1+20+32+32`); the array was 53
   because the salt was written *over* the initcode hash instead of before it, reading 32
   bytes past its own buffer on every attempt. **The keccak vector test still passed** —
   testing the hash function does not test the code that assembles its input.
3. **`bench_mode` read `t0` in `main()` and `t1` in the callee**, so `t0` was uninitialised
   stack and the benchmark reported 2593 seconds for a run that takes two.

Every salt in this repository is re-derived with Foundry's keccak — an implementation
independent of `vanity.c` — before anything is deployed.

---

## 5. Measured cost

From `python3 scripts/mining-cost.py` on 4 cores at ~4.3M keccak/s:

| Suffix bytes | Hex digits | Expected attempts | Expected time |
|---|---|---|---|
| 2 | 4 | 65,536 | 14 ms |
| 3 | 6 | 16,777,216 | **3.6 s** |
| 4 | 8 | 4,294,967,296 | **15.4 min** |
| 5 | 10 | 1,099,511,627,776 | 2.7 days |
| 6 | 12 | 281,474,976,710,656 | **1.9 years** |
| 7 | 14 | 7.2 × 10¹⁶ | 490 years |
| 8 | 16 | 1.8 × 10¹⁹ | 125 thousand years |

Asset names at their full encoding:

| Name | ASCII hex | Bytes | Expected |
|---|---|---|---|
| `USD` | `555344` | 3 | 3.6 s |
| `GOLD` | `474f4c44` | 4 | 15.4 min |
| `OIL` | `4f494c` | 3 | 3.6 s |
| `GOLDX` | `474f4c4458` | 5 | 2.7 days |
| `SILVER` | `53494c564552` | 6 | 1.9 years |

**4 bytes is the practical ceiling.** The distribution is geometric, so roughly half of runs
finish under 0.69× the mean and a long tail runs well past it. A run exceeding 3× the mean
is ordinary, not a bug — the first full-GOLD attempt reached ~35 minutes against a 15-minute
mean.

---

## 6. Deployed (3-byte `GOL`, verified)

Both are on NEXORA Testnet, EVM chain id **902024** (`eip155:902024`). Source of truth:
`deployments/vanity-testnet.json`.

### 6.1 `0x5811af632bceba01e8599bc07a471aa18a474f4c`

Factory `0x61028fc00e7283Cf0Af586B6462d1671C28B6797`, salt `0x…0104734a`.

**Finding, and it is a real one.** CREATE2 makes the *factory* `msg.sender` inside the
constructor, not the EOA that sent the transaction. A standard ERC-20 mints to
`msg.sender`, so the entire supply landed on the factory — which holds nothing, can call
nothing, and has no ERC-20 interface. Confirmed live: `balanceOf(factory) == 1e26`, and a
transfer *from* the factory reverts. **Those tokens are stranded and cannot be moved.**

### 6.2 `0x15541299bc9c98d3ac1dc0e2c50495d9b9474f4c`

Same 3-byte suffix, deployed through a second factory `0x34b0c47A7aF2cD273b614aCACfd04251b89aDDE3`
that has `deployAndCall()`, which forwards the supply to a real EOA in the same transaction
and leaves no standing authority. This is the deployment used for ERC-20 behaviour checks.

A first attempt on this factory called `transfer(holder, 0)` because the amount was left at
zero, so the supply stayed put and the deployment was abandoned. It is kept in the record
because it is the proof that a CREATE2 salt cannot be reused for a second deployment at the
same address.

### 6.3 The factory could not be upgraded, and that was deliberate

An EVM address is `keccak256(rlp([deployer, nonce]))[12:]` and depends on nothing about the
code. That is exactly why the factory was made immutable, ownerless and stateless from the
start — a deployer that could change would silently invalidate every salt mined against it.

The same property makes it impossible to *update*. EIP-684 forbids placing code on an
account that already has it, and the factory exposes no `SELFDESTRUCT`, so there is no path
to replacing its runtime in place. Adding `deployAndCall()` therefore required a **new**
factory address, which killed every salt mined against the first one. That cost is paid
knowingly rather than discovered later. `scripts/refresh-create2-deployer.sh` exists to
document that it cannot be done.

### 6.4 Verified behaviour

```
name()      "GOLD"
symbol()    "GLD"
decimals()  18
totalSupply()  100000000000000000000000000
```

Live testnet transfer, executed and re-read:

```
sender differs from recipient                   0x2790446b... -> 0xae78a74b...
transfer receipt status == 1                    1 (success)
recipient balance increased by exactly the amount   2.5e18 -> 3.5e18
sender balance decreased by exactly the amount      9999999750e18 -> 9999999650e18
total supply unchanged by the transfer          conservation
```

**24/24 checks pass** (`scripts/verify-vanity.py`). Reproduce with:

```bash
python3 scripts/verify-vanity.py \
  --label "GOL-suffix, supply forwarded (3 bytes)" \
  --transfer --key-file <ephemeral test key> \
  --to <a different address> --amount 1000000000000000000
```

---

## 7. Full `GOLD` target — pending

| Field | Value |
|---|---|
| Target suffix | `474f4c44` = ASCII `GOLD` |
| Deployer | `0x34b0c47A7aF2cD273b614aCACfd04251b89aDDE3` |
| Initcode hash | frozen, in `.vanity/gold-params.txt` and `deployments/vanity-testnet.json` |
| Initcode size | 5278 bytes |
| Salt | **none yet** |
| Address | **none yet** |

The initcode is frozen and recorded. Any edit to `VanityAsset.sol`, to the constructor
arguments, or to the compiler version changes that hash and invalidates the search — which
is precisely what happened once already, when constructor arguments were added after a salt
had been mined.

This section will only be updated when a salt exists, its derivation has been independently
verified with Foundry, and the contract is deployed and re-read on chain.

---

## 8. Limits, stated plainly

- **4 bytes is the ceiling on this machine.** 5 bytes is days, 6 is years. Longer asset names
  such as `SILVER` cannot be mined in full here.
- **The real cost is not CPU.** A salt is valid for one exact initcode hash. Change one byte
  of the contract and the address is dead and the search restarts. Record the initcode hash
  and compiler version with every salt; `.vanity/` does this.
- **Anyone can front-run.** CREATE2 salts cannot be reused by the same deployer
  (`test_SameSaltSameDeployerCannotRedeploy`), but any account can deploy to any address
  first. There is no reservation system in the EVM. Deploy promptly or verify afterwards.
- **A mined address is not an identity.** `AssetRegistry` is the durable layer; a name in a
  registry can be re-pointed, a mined address cannot. Keep them separate and do not let
  registry metadata imply an asset is legitimate or real.
- Unaudited. Testnet only. Not mainnet. No value, not tradable.