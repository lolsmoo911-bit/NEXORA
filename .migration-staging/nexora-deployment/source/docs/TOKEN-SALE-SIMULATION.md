# Token sale simulation — TESTNET ONLY

**Nothing here is for mainnet. None of it has monetary value.** This is a simulation of sale
*mechanics* so the arithmetic, the caps and the failure modes can be exercised before anyone
writes real code.

---

## The domain question comes first

`nexora.io` **is not yours.** It has been registered at GoDaddy since 2024-08-05 with WHOIS
privacy on, the apex parked, and a deleted Framer site on `www`. Anyone building public
branding on that name is building on someone else's.

That does not block the simulation — which is why this document exists — but it means
**branding is genuinely open**, not deferred. Rename whenever you like; nothing here depends
on it.

## Why ANEX is not the saleable asset

ANEX is the chain's **native currency**, held in the Cosmos `bank` module under the denom
`anex`. It is not an ERC-20 and no Solidity contract can govern it. A fixed-price sale needs
its own token contract, which is what `NexoraTestToken.sol` is.

| | ANEX | NXTT (`NexoraTestToken`) |
|---|---|---|
| Layer | Cosmos `bank` module | EVM ERC-20 |
| Denom | `anex` | 18 decimals, in-contract |
| Governed by Solidity | no | yes |
| Tradeable in the simulation | no | yes |
| What it is | gas currency | the token the vault sells |

---

## What the vault models, and what it deliberately does not

**Models** — and these are covered by tests:

| Behaviour | Test |
|---|---|
| Fixed price per whole token | `test_CostMath` |
| Exact-out purchase, priced by the contract | `test_BuySucceedsAndUpdatesState` |
| Hard sale cap | `test_GlobalCapEnforced` |
| Per-address cap | `test_PerAddressCapEnforced` |
| Sale window | `test_SaleWindowRespected` |
| Pause / close | `test_PauseStopsBuying` |
| Overpayment refunded, not absorbed | `test_OverpaymentIsRefunded` |
| Underpayment rejected | `test_UnderpaymentReverts` |
| Only the owner withdraws | `test_NonOwnerCannotWithdraw` |
| Token shortfall blocks a purchase | `test_TokenShortfallBlocksPurchase` |
| Several buyers accumulate correctly | `test_MultipleBuyersAccumulate` |

**Does not model**, because each is its own project and a production sale needs all of them:

- KYC/AML and jurisdiction geofencing
- Vesting, cliffs, unlock schedules
- A multisig or timelock controlling the owner key
- A real payment rail
- An independent audit

**13 tests pass. The suite has teeth:** deleting the sale-cap check makes
`test_GlobalCapEnforced` fail, so it is not a suite that passes no matter what.

---

## Three real bugs this exercise found

Recorded because each would have shipped:

1. **`balanceOf` name collision.** A public state variable named `balanceOf` auto-generates
   `balanceOf(address) → uint256`, which collides with the ERC-20 function returning the
   *caller's* balance. The contract did not compile. Fixed by declaring the ERC-20 surface
   explicitly and keeping the mapping private.

2. **`_allowances` declared single-level, used nested.** `mapping(address => uint256)` was
   indexed twice. Also a compile error, caught the same way.

3. **A test asserting the wrong number.** `test_CostMath` claimed 33.33 tokens at 0.05 cost
   5. It costs 1.666… — `cost = tokens × price / 1e18`, truncated. The test was green against
   a contract I had not yet written correctly, and would have hidden a real pricing bug.

Two further failures were test-harness bugs worth knowing about: `vault.costOf(...)` written
*inside* a `vm.expectRevert` statement consumes the expectation, and a call carrying more
value than the account holds dies with `OutOfFunds` before the contract body runs at all.

---

## Running it

```bash
cd contracts
forge build
forge test
```

| Test | Result |
|---|---|
| `SaleSimulationTest` | **13 passed, 0 failed** |

---

## Deploying to the testnet

```bash
anvil                                   # local EVM
forge create src/NexoraTestToken.sol:NexoraTestToken \
  --broadcast --rpc-url http://127.0.0.1:8545 --constructor-args 1000000000000000000000000000

forge create src/TestSaleVault.sol:TestSaleVault --broadcast \
  --rpc-url http://127.0.0.1:8545 --constructor-args \
  <token> <treasury> 50000000000000000 1000000000000000000000000 10000000000000000000000 \
  <startsAt> <endsAt> 0
```

Every figure above is fabricated for simulation.

---

## Before any of this becomes real

1. **Do not deploy this on mainnet.** It has not been audited and the owner key is a plain EOA.
2. **Rebrand first.** You do not own `nexora.io`.
3. **A price target is not a configuration.** If a launch price of $3.XX is the goal, it
   follows from supply and demand, not from a field. Set the price in the contract for
   *simulation*; on a real chain the market sets it.
4. **Get the legal structure in place before a fixed-price sale.** A fixed price plus market
   trading is how most jurisdictions define a security.
5. **Then commission an audit.** Not optional.