# Asset Naming System (ANS) — technical proposal + implementation

**TESTNET ONLY. Unaudited.** Addresses the proposal to have asset names visible in contract
addresses.

---

## 1. Why the address format in the proposal cannot be built

The proposal was:

```
0x000...(5 to 9 random hex chars)...000GOLD
```

Two separate problems, and the second is not a matter of effort.

### 1.1 You cannot choose an EVM contract address

An EVM contract address is `keccak256(rlp([deployer, nonce]))[12:]`. It is computed by the
protocol from the deployer's address and the nonce. There is no field, no parameter, and no
"register this address" call that lets you request one.

The only way to obtain a specific address is to **mine** it: increment the nonce, compute the
address, and deploy only when it matches — discarding every attempt that does not.

### 1.2 The cost, measured

| Suffix | Hex chars | Attempts | Reality |
|---|---|---|---|
| `4c44` | 4 | 65,536 | instant |
| `474f4c44` | 8 | 2³² ≈ **4.3 billion** | hours to days per address, GPU |
| `474f4c4400` | 10 | 2⁴⁰ ≈ 1.1 trillion | not practical |

And 8 hex characters is only **4 of the 20 bytes** in an address — 20% of it, the remaining
80% still random. The proposal asked for "5 to 9 random symbols AND a visible suffix",
which at 8 hex chars is 4.3 billion attempts *per asset*.

Your asset list — bonds, fiat, equities, precious metals — is dozens to hundreds of
addresses.

### 1.3 The decisive problem: the address is welded to one deployer key

The address depends on `(deployer, nonce)`. Redeploy the contract after an audit, with a new
deployer key, or on a different chain — **the address changes and must be re-mined from
scratch.** A name you mined today is not a durable identity. A name in a contract is.

---

## 2. What was built instead

`contracts/src/AssetRegistry.sol` — human-readable name → address, the way ENS and
Unstoppable Domains do it, because it survives redeployment.

```solidity
registry.resolve("GOLD");                  // -> 0x...
registry.get("gold");                      // case-insensitive
registry.claim("GOLD");                    // assert control of an address
registry.linkAssetId("GOLD", aidBytes32);  // bind to the AID machine identifier
```

### Relationship to AID

The repo already contains `aid/`, which produces a deterministic `bytes32` that no two assets
can share. The two compose:

| Layer | Answers | Form |
|---|---|---|
| **AID** | *which* asset is this? | `bytes32`, computed by anyone, no registry |
| **ANS** | *what is it called?* | `"GOLD"`, resolves to an address |

`linkAssetId` binds them, so a name resolves to both.

---

## 3. The design decision that actually mattered

**Confusable letters must be ALLOWED, not banned.**

The first implementation rejected `O`, `I`, `l` as confusables. The tests immediately
caught the contradiction:

```
FAIL: Confusable("GOLD", "letter O looks like zero")
```

**`GOLD` contains an `O`.** `SILVER` contains an `I`. `OIL` contains both. A naming system
that cannot register the flagship asset is useless, and a letter ban is the wrong tool
anyway.

Worse, the first ban was **case-inconsistent**: it ran *after* case folding, so it rejected
`gold` but accepted `GOLD`. That hands an impersonator the exact spelling nobody defends.

### What replaced it

Impersonation is prevented **structurally**, not by banning characters:

- `GOLD`, `G0LD`, `GoLD` and `GO1D` all produce the same **fingerprint**
  (`o/O/0 → o`, `i/I/l/L/1 → i`)
- once a name is registered, any later name with the same fingerprint is **rejected**
- so `G0LD` can never be registered while `GOLD` exists

This is strictly better than a ban: the real name works, and the attack is still blocked.

### A real hole this found

The digit **`1`** was initially missing from the confusable map. `GO1D` therefore
fingerprinted differently from `GOLD` and impersonation passed straight through — the exact
hole the function exists to close. Caught by mutation testing, now covered by
`test_FingerprintsCollideAsIntended`.

---

## 4. Other defences

| Defence | Test |
|---|---|
| ASCII only — no Unicode lookalikes | Cyrillic `ЗОЛ` rejected (`test_NonAsciiRejected`) |
| Case-folded — "Gold" and "gold" are one identity | `test_UppercaseFoldsToLowercase` |
| Never overwritable — no update path | `test_CannotDoubleRegister` |
| First-come, first-served | same |
| Unknown name returns zero, never reverts | `test_UnknownNameIsZeroNotRevert` |
| `claim()` records control without moving the address | `test_ClaimRecordsOwner` |
| Only a claimant may bind an asset id | `test_LinkingAssetIdRequiresClaimForNonOwner` |
| Length 3–63 | `test_MinAndMaxLengthAccepted` |
| Punctuation and hyphens rejected | `test_PunctuationRejected`, `test_HyphenRejected` |

**53 tests pass** across three suites.

### Mutations, to prove the suite bites

| Mutation | Result |
|---|---|
| Remove the impersonation check | **killed** — 2 tests fail |
| Remove digit `1` from confusables | **killed** — 2 tests fail |

---

## 5. Running it

```bash
cd contracts
forge test --match-contract AssetRegistryTest

# deploy
forge create src/AssetRegistry.sol:AssetRegistry --broadcast \
  --rpc-url http://127.0.0.1:8545 --private-key $DEPLOYER

# register and resolve
cast send $REGISTRY "register(string,address,uint32)" GOLD $TOKEN 2 \
  --private-key $DEPLOYER
cast call $REGISTRY "resolve(string)(address)" GOLD
cast call $REGISTRY "fingerprintOf(string)(bytes32)" G0LD   # same as GOLD
```

---

## 6. If you still want vanity addresses

It is possible, and pointless for this use case, but the numbers are:

- **4 hex chars** (`4c44`): instant, meaningless — 1 in 65k, everyone finds one
- **8 hex chars** (`474f4c44`): ~4.3 billion attempts, hours-days per address on GPU
- reuse across deployments: **impossible** without the same deployer key and nonce

If you want the vanity *look* for a single flagship address, mine one. Do not build the
identity system on it.

---

## 7. What is still missing

- **No oracle.** ANS names assets; it does not price them. A bond, stock or metal token needs
  a price feed with staleness bounds. This is the next real engineering gap.
- **No renewal, expiry or grace period** — `GRACE_PERIOD` is declared but unused.
- **No subdomains** (`gold.nx.io`), no resolver text records, no reverse lookup.
- **No enumeration on-chain** — deliberately: you cannot iterate a mapping. Index
  `Registered` events off-chain, which is the correct design.
- **No transfer of a name.** Deliberate, but it means a mistaken registration is permanent.
- **No registrar/ownership model** for the registry itself. Who can register `ANEX`?
- Unaudited. Testnet only.

---

## 8. Live on the NEXORA testnet

Registry deployed and populated. Chain `eip155:902024`.

| Name | Type | Resolves to |
|---|---|---|
| `ANEX` | native (1) | `0x0000000000000000000000000000000000000000` |
| `NXIT` | ERC-20 (2) | `0x28B081E92CEf14492Ba90fdBCeCbe0693F9a1f8d` |
| `NEXORA` | ERC-20 (2) | `0x550Ff8f34042a9cDdD23729113590E678C9fAddA` (sale vault) |
| `VAULT` | ERC-20 (2) | same vault, alias |
| `VESTING` | ERC-20 (2) | `0xF8c4AbD2d2573eBDA51cc886A9b6882E435C80A2` |

**Registry address: `0x3e4a3Bebe3f2bE966c972bAeed974062cEc5CeC2`**

Verified through the public RPC, not only against localhost:

```bash
cast call 0x3e4a3Bebe3f2bE966c972bAeed974062cEc5CeC2 "resolve(string)(address)" NXIT \
  --rpc-url https://<tunnel>/api/nexora/evm
# -> 0x28B081E92CEf14492Ba90fdBCeCbe0693F9a1f8d
```

### The guard fired on the live chain

```
$ cast send 0x3e4a3Bebe3f2bE966c972bAeed974062cEc5CeC2 "register(string,address,uint32)" NX1T <addr> 2
Impersonation("nx1t", 0x94971ea4...736d1)
```

`NX1T` is `NXIT` with digit `1` for letter `I`. It was rejected.

### Gap that only appeared at deployment time

`ANEX` is the gas token and **has no contract address**. The first version of `register()`
rejected the zero address outright, which made the chain's own currency unregistrable —
found while wiring the live deployment, not by any test.

Fixed: zero is accepted for `TYPE_NATIVE` and only that type, and existence moved to an
explicit `registered` flag rather than being inferred from a non-zero address.

```solidity
if (contractAddress == address(0) && assetType != TYPE_NATIVE) revert ZeroAddress();
```

Covered by `test_NativeTokenRegistrableAgainstZeroAddress`,
`test_ZeroAddressStillRejectedForERC721`, `test_NativeNameCannotBeDoubleRegistered`.

### Test count and mutation coverage

**58 tests pass** across three suites.

| Mutation | Result |
|---|---|
| Remove the impersonation check | **killed** — 2 tests fail |
| Remove digit `1` from confusables | **killed** — 2 tests fail |
| Allow zero address for every type | **killed** — 2 tests fail |
| Existence back on `contractAddress != 0` | **killed** — 1 test fails |
