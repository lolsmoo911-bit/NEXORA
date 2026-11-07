# Phase 5 report — AID registry and deterministic deployment

**Status: COMPLETE.** All deliverables verified by execution.

Date: 2026-10-12. Evidence run: [#38247229940](https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38247229940) — `conclusion: success`. Commit: `bd1e920ba9f5298074ef9912b15e07aa4f125461`.

---

## 1. Deliverables against the ROADMAP

| Deliverable | Status | Where |
|---|---|---|
| Minimal registry contract | **MET** | `aid/src/AidRegistry.sol`, 16 tests |
| CREATE2 factory | **MET** | `aid/src/AidFactory.sol`, 13 tests |
| Local vanity search, honest complexity | **MET** | `aid/scripts/vanity.mjs`, 14 tests |
| Independent verification of the search | **MET** | `cast compute-address` + pinned vector |

Totals from the run: **40/40** JavaScript tests, **45/45** Solidity tests.

## 2. What the registry actually guarantees

Three properties, each named in the contract header and each tested against an attempt to violate it:

1. **The metadata hashes to the identifier it is filed under.** Every registration
   recomputes `assetId(type, key)` and reverts on mismatch. Without this, a directory entry
   could describe something other than what its own key names. Tested with the wrong key,
   the wrong type, and the wrong chain id.
2. **First claim wins, permanently.** A retraction is *final*: the identifier cannot be
   claimed again. If it could, retraction would be an invitation to squat and first-claim-wins
   would hold only until the first bad actor arrived.
3. **Only the original registrant can retract.**

What the registry explicitly does **not** do: attest that an asset exists. `aid/SPEC.md` §3
says an `assetId` is an identifier and not a claim about the world, and the contract says so in
its own header. A consumer treating membership as proof of existence is misreading it.

There is no owner, no upgrade path, and no pause. Those would be a governance problem, and
Phase 8 governance does not exist yet.

## 3. The three ways CREATE2 is usually got wrong

Each is named in `AidFactory.sol` and each is tested by attempting it:

| Failure | What happens without the guard | Test |
|---|---|---|
| Address collision | CREATE2 silently returns the *existing* contract; a deployment looks successful and deploys nothing | `test_secondDeploymentWithTheSameSaltReverts` |
| Constructor-argument drift | Same salt, different arguments → same address as far as the caller is concerned, different contract underneath | `test_constructorArgumentsChangeTheAddress` |
| Deployer-dependent address | A vanity address found for one deployment path is invalid for another | `test_theDeployerIsPartOfTheAddress` |

The deployment body also re-derives the address from the actual deployment rather than
trusting the caller's salt, and turns CREATE2's `0` return into a revert — returning `0`
would hand the caller an address that was never deployed.

## 4. The vanity search, and why its numbers are believable

Measured in CI, `0000` pattern, 186,485 attempts/second:

```
kind               : leading zero hex digits (4)
success probability: 16^-k = 0.0000152587890625
expected attempts  : 16^k = 65,536
actual             : 50,009 attempts in 0.27 s

projection at the measured rate
  4 zeros -> 65,536       -> 0 s
  5 zeros -> 1,048,576    -> 6 s
  6 zeros -> 16,777,216   -> 90 s
  7 zeros -> 268,435,456  -> 24 min
  8 zeros -> 4,294,967,296-> 6.4 h
```

The tool prints the projection for sizes it did **not** search, because the size that matters
is usually one digit harder than the one you tried, and a tool reporting only "found in 0.27 s"
hides that. It also states that the projection uses *this machine's* rate.

A vanity address buys nothing cryptographically and the tool says so: the search is over
public inputs, anyone can reproduce it, and `0x0000…` does not make the contract at that
address anything other than whatever was deployed. NEXORA uses it so addresses in documentation
and test fixtures are visually distinguishable.

### Independent verification

A search tool that computes CREATE2 addresses with its own arithmetic and then congratulates
itself has verified nothing. Two checks tie it to the EVM:

- `test_predictMatchesTheDeployedAddress` proves `AidFactory.predict` equals what the EVM's
  own CREATE2 actually produces.
- CI runs `cast compute-address` — Foundry's separate implementation — against the search
  result:

```
vanity.mjs  : 0x00005b6a978cae0c47315439b2ac779c4634a55f
cast        : 0x00005b6a978cae0c47315439b2ac779c4634a55f
OK: two independent implementations agree on the CREATE2 address
```

That vector is also pinned in `aid/test/vanity.test.mjs`, so the derivation is checked against
a Foundry-produced value in every run, not only in the CI step that happens to call `cast`.

## 5. Two bugs in the search tool itself

Both were in the one part of the tool whose job is to state the cost honestly.

**Counting zeros.** `/^0x?/` treats the `0` as mandatory and the `x` as optional, so the
pattern silently consumed one leading zero: `0000` was reported as *three* digits with 16³
expected attempts instead of 16⁴ — an eight-fold understatement.

**Splitting a trailing run.** `([0-9a-f]+)(0+)` backtracks greedily and splits `abc0000` as
`abc000`/`0` — one trailing zero instead of four. A lazy quantifier fixes the output but
moves the subtlety rather than removing it. The fix counts the run with `/0+$/`, which has no
choice to make.

Both are now permanent tests.

## 6. Supply-chain change made along the way

`foundry-rs/foundry-toolchain@v1` with `version: stable` was replaced with a pinned
`v1.8.5` tarball verified against the release's published digest. Two reasons, both measured:
the action resolves the newest release at run time, so two runs of the same commit can test
against different compilers; and it fetches a signature attestation from an endpoint that
returned HTTP 504 on two consecutive runs, taking the whole job down.

## 7. Limits — stated, not implied

- The contracts are **untested on the NEXORA chain**. They ran under Foundry's EVM; the
  compatibility question belongs to Phase 6.
- **No adversarial testing**: no reentrancy or gas-griefing analysis, no invariant fuzzing
  beyond the unit tests, no formal verification. `paginate` and the registry's storage growth
  were not load-tested.
- The registry has **no governance, no upgrade path and no pause** — deliberately, and that is
  a limitation as well as a decision.
- **Nothing here has been audited.** Passing tests are not a security result.
