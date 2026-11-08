# Round 2 — NXIT + vesting, executed on-chain

**TESTNET ONLY. Unaudited. No monetary value.** Round 1 was the bare sale; round 2 adds the
token symbol change and a vesting schedule.

Date: 2026-10-13 · chain `eip155:902024` · EVM `902024` (`0xdc388`)

---

## Addresses

| | |
|---|---|
| `NexoraTestToken` (**NXIT**) | `0x28B081E92CEf14492Ba90fdBCeCbe0693F9a1f8d` |
| `TestSaleVault` | `0x550Ff8f34042a9cDdD23729113590E678C9fAddA` |
| `LinearVesting` — 400k, 30d cliff / 365d | `0xF8c4AbD2d2573eBDA51cc886A9b6882E435C80A2` |
| `LinearVesting` — demo, 100k, no cliff / 2h | `0x483fC2ef9a8bF01a9532c415806bF20A5AE26844` |

`symbol()` returns **`NXIT`**, read back from the deployed contract.

---

## Results

### Sale

| | |
|---|---|
| buyer3 bought | **3,000 NXIT** |
| paid | **150 ANEX** (3,000 × 0.05, exact) |
| receipt status | **`0x1`** |
| block | 2768 |
| gas used | 130,897 |
| fee | 0.000130897 ANEX |

### Vesting — the 30-day schedule behaves correctly

```
total       400,000 NXIT
held        400,000 NXTT
vested          0     <- the 30-day cliff has not elapsed
releasable      0
```

Nothing unlocks early. That is the point of the cliff, and it is the failure mode most worth
seeing work.

### Vesting — the curve, observable live

A second schedule was deployed with a **2-hour** duration and a start **1 hour in the past**,
so the linear curve is visible on a real chain rather than only in a unit test:

```
vested       50,125 NXIT   (just over half — the hour that elapsed)
vested bps   5012          (5000 = exactly halfway)
releasable   50,125
```

Then claimed:

```
released     50,152.77777777778 NXIT
still held   49,847.22222222222 NXIT
```

The claim succeeded (`status 1`), the schedule's `released` advanced, and the tokens actually
moved. The small difference between the read and the claim is time passing between the two
calls — the schedule accrues continuously, so a later claim is slightly larger. That is
correct behaviour, not drift.

---

## Tests: 30 passing

| Suite | Tests |
|---|---|
| `SaleSimulationTest` | 13 |
| `VestingTest` | 15 → **17** |

Vesting coverage: nothing before the cliff · zero at the cliff instant · halfway is half ·
saturates after the end · **never exceeds total** · monotonic curve · claim pays accrual ·
double-claim at the same instant pays nothing twice · **incremental claims equal a single
claim** · full drain leaves no dust · stranger cannot claim · cliff > duration rejected ·
zero beneficiary rejected.

### Two mutations, and one that survived

| Mutation | Result |
|---|---|
| Remove the cliff check | ✅ **killed** — 2 tests fail |
| Remove the saturation branch | ❌ **survived** 15/15 |

The second one is the interesting result. `if (elapsed >= duration) return total;` and the
plain ratio `(total * elapsed) / duration` return **the same number when `elapsed` exactly
equals `duration`** — which is where every existing test sampled. The suite genuinely could
not tell a correct contract from an over-vesting one.

Fixed by adding `test_NeverVestsMoreThanTotal`, which warps **10 years past** the end date and
asserts the value saturates at `TOTAL`. Re-running the mutation now kills 2 tests.

*A passing suite is not evidence the code is right. This one was wrong for a moment and the
only thing that caught it was deliberately breaking the code on purpose.*

### Two real bugs this round

1. **`token.approve(address(vest = new LinearVesting(...)), TOTAL)`** approved the vault
   *after* the constructor had already tried to pull, so `setUp` died with
   `InsufficientAllowance`. You cannot approve an address that does not exist yet.

   Fixed properly, not by reordering: **`fund()` was split out of the constructor**. The
   deposit is now an explicit, observable state transition rather than something implied by
   deployment.

2. **The saturation gap above** — a real hole in coverage, found only by mutation.

---

## What still does not exist

- **No oracle.** Your stated model is tokens mirroring bonds, fiat, equities and metals.
  That requires a price feed — Chainlink, Pyth, or a custom oracle with update permissions
  and staleness checks. `NXIT` has a price *written into a constructor argument*. It is not
  tied to anything.
- No audit, KYC, geofencing, multisig, or timelock.
- The `TestSaleVault.refundAll` proportional refund is still computed-and-discarded.
- `nexora.io` is not yours.
- Single host, free tier, sleeps when idle.

## Suggested next technical step

An **oracle adapter** with a staleness bound, tested against a mock feed that goes stale. That
is the dependency that turns these from plain tokens into asset-referencing tokens, and it is
the first thing that will bite you otherwise.