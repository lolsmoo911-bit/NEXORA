# Vanity Addresses — hex-suffix deployment on NEXORA

**TESTNET ONLY. The token deployed here has no value and is not officially tradable.**
This is the Hex Encoding + Vanity Generation approach. It works. This document records
what was measured and what is deployed on chain, with the evidence for each claim.

---

## 1. Current status

| Item | State |
|---|---|
| **Full 4-byte `474f4c44` ("GOLD")** | **DEPLOYED AND VERIFIED** |
| 3-byte suffix `474f4c` ("GOL") | deployed and verified, two deployments (superseded) |
| Miner, tests, verification script | complete, all in CI |

CI: <https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38479155214> — commit
`9fb3728518ba0bfe765416d23ac9b5352e3f7a17`, three jobs all green.

### The target

```
0xa9816d769cb64eccaba2ee093be619af474f4c44 └──────────┬──────────┘
                                                    474f4c44
```

`474f4c44` is the complete ASCII hex encoding of **GOLD** — all four bytes, not a prefix.

| | |
|---|---|
| Chain | NEXORA Testnet, EVM chain id **902024** (`eip155:902024`) |
| Deployer | `0x34b0c47A7aF2cD273b614aCACfd04251b89aDDE3` |
| Salt | `0x00000000000000000000000000000000000000000000000000000000076f3f70` |
| Initcode hash | `0x6447bb54ec9524614984fd569098dcefeb1d5ba2c4275fa4f109a99cf4d006d8` |
| Initcode size | 5278 bytes, frozen and re-verified immediately before deploy |
| Deployment tx | `0x07b20f3b393edcaff2d34f2a429aa7e58a8da99e61441a092b25eafc1df87917` |
| Block | 9147, receipt status `0x1`, 2 logs |
| Runtime code | 3464 bytes |
| Winning salt counter | 124,731,248 against a mean of 2³² = 4,294,967,296 |

Three independent derivations agree, and all three are in CI:

| Method | Result |
|---|---|
| Miner's own keccak (`scripts/vanity.c`) | `0xa9816d769cb64eccaba2ee093be619af474f4c44` |
| Foundry `cast keccak` | `0xa9816d769cb64eccaba2ee093be619af474f4c44` |
| On-chain `computeAddress()` in the factory | `0xa9816d769CB64eCcAba2EE093BE619Af474F4C44` |

It finished at 0.029× the mean because the search is geometric — the first match often
arrives long before the mean, which is the same effect that made an earlier run take 35
minutes against a 15-minute mean.

```
name()        "GOLD"
symbol()      "GLD"
decimals()    18
totalSupply() 100000000000000000000000000
```

Live testnet transfer on this contract: recipient `0 → 5e18`, sender `1e26 → 99999995e18`,
total supply unchanged. **24/24 checks pass.**

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
| `.github/workflows/contracts-vanity.yml` | CI: forge test, miner/Foundry keccak cross-check, cost arithmetic, record validation |

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

**24/24 checks pass** with a live transfer; **19/19** without one. All of it still passes
after a full chain restart (the state is persistent, not in-memory). Reproduce with:

```bash
python3 scripts/verify-vanity.py \
  --label "GOL-suffix, supply forwarded (3 bytes)" \
  --transfer --key-file <ephemeral test key> \
  --to <a different address> --amount 1000000000000000000
```

---

## 7. Reproducing the `GOLD` address

The full derivation is a pure function of three recorded values, so anyone can recompute it
without trusting the miner, without a chain, and without spending CPU:

```bash
D=0x34b0c47A7aF2cD273b614aCACfd04251b89aDDE3
S=0x00000000000000000000000000000000000000000000000000000000076f3f70
I=0x6447bb54ec9524614984fd569098dcefeb1d5ba2c4275fa4f109a99cf4d006d8
cast keccak 0xff${D#0x}${S#0x}${I#0x} | cut -c25-   # -> 0xa9816d769cb64eccaba2ee093be619af474f4c44
```

And against a live chain, through the factory:

```bash
cast call $D "computeAddress(bytes32,bytes32)(address)" $S $I --rpc-url $RPC
```

The initcode is frozen and recorded in `.vanity/gold-initcode.hex`, and its hash was
re-verified as unchanged immediately before deployment. Any edit to `VanityAsset.sol`, to
the constructor arguments, or to the compiler version changes that hash and kills the salt
— which is exactly what happened once during this work, when constructor arguments were
added after a salt had already been mined.

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