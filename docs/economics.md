# Economics — placeholder, nothing decided

**Status: NO DECISIONS HAVE BEEN MADE.** This file exists because `SPEC.md` §5 references it
and a broken reference is worse than an honest gap. It is written to make the open questions
explicit rather than to imply that answers exist.

## There is no token

The only thing that exists today is a denomination in `chain/nexora-devnet.json`:

```json
"denom": { "base": "anex", "display": "nex", "exponent": 18, "symbol": "NEX" }
```

It is written into genesis accounts. It has:

- **no contract** — no ERC-20, no ERC-721, nothing deployed on the chain
- **no supply model** — total supply is whatever genesis assigns, by default
- **no issuance schedule** — no mint, burn, halving or staking-inflation policy
- **no allocation** — no team, investors, treasury, foundation or community split
- **no vesting or unlock schedule**
- **no price, liquidity venue or market**
- **no trademark, domain or legal review** — `SPEC.md` §2 records this as outstanding

## One parameter is not a choice

The 18 decimals are **forced by the upstream stack**. Cosmos EVM supports 18-decimal gas-token
chains only, and the `x/precisebank` module that provided 6→18 conversion was removed upstream
(PR #1019, 2026-03-02) and is absent from the pinned tree. A non-18-decimal denomination is not
an available option on this baseline.

## What would have to be decided, and by whom

None of this is an engineering question. Each is a decision only the owner can make, and
several need legal advice.

| Decision | Why it matters | Status |
|---|---|---|
| Is there a token at all? | Everything below depends on the answer | **undecided** |
| Fixed supply or emission schedule? | Determines whether NEX is a currency or a share of something | **undecided** |
| Who receives what, and when? | Vesting and unlock mechanics are the most common source of exchange-listing problems | **undecided** |
| What is the token *for*? | Gas only? Staking? Governance? Fee sharing? These imply entirely different contracts | **undecided** |
| Which validator commission and fee split? | Currently inherited upstream defaults, not chosen | **undecided** |
| Identity: name, symbol, domain | Trademark availability is explicitly not checked | **undecided** |
| Jurisdiction and securities status | A token sold for profit may be a security in some jurisdictions | **not reviewed — requires counsel** |

## Why nothing was invented here

An agent can derive a bond-pricing formula; it cannot derive a community's appetite for
supply inflation. Writing plausible-looking numbers into this file would create the
appearance of a decision where none was made, and the next reader — including a future
version of this agent — would treat them as settled.

The `anex` balances in genesis are **test tokens** recovered at runtime from public upstream
test mnemonics published in `cosmos/evm`'s `local_node.sh`. They are not a distribution and
must never hold value.

## What exists instead

For identifying assets — including instruments a market simulation would price — there is
**AID**: a deterministic identifier scheme in [`aid/SPEC.md`](../aid/SPEC.md), with two
independent implementations that agree on every test vector. AID is not a token and does not
make the native coin special; the native coin is simply the zero-key entry in its namespace.
