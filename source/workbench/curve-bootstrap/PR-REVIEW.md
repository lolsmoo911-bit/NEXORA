# PR-style review: annual par-yield curve bootstrap (isolated prototype)

Status: prototype only; not merged into the canonical repository; canonical upstream,
GitHub and Market Data Hub untouched.

## Proposed API (workbench: C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\workbench\curve-bootstrap)
- `bootstrapParCurve(parQuotes)` from `src/curve.mjs`. Input: explicitly ordered annual
  par quotes `[{ tenorYears: 1, parYield: 0.05 }, ...]`.
- Output: one node per quote, in input order:
  `{ tenorYears, parYield, discountFactor, annualEffectiveZeroRate }`.

## Mathematical definition
Par bond of tenor n years, par yield c_n, annual coupons, face 100, priced at par:
    100 = 100*c_n*(DF1 + ... + DF(n-1)) + 100*(1+c_n)*DFn
so with every earlier annual DF already bootstrapped:
    DFn = (1 - c_n * sum(DF1..DF(n-1))) / (1 + c_n)
and the annual effective zero rate at each node is
    z_n = DFn^(-1/n) - 1.

## Input discipline (deliberately unforgiving)
- Tenors must be exactly the consecutive positive integers starting at 1, in order:
  no gaps, no duplicates, no silent sorting (a sorted input is an input somebody's
  process rewrote; the caller proves the order, the function refuses to guess it).
- parYield finite and > -1; NaN / Infinity / <= -1 / non-numeric all rejected.
- Array shape enforced; empty input rejected; quote objects must carry both fields.
- A quote whose bootstrap yields a non-finite or non-positive DF is rejected loudly.
- Input is never mutated; outputs are fresh objects; the function is pure.

## Scope and stated limitations
- Annual-pay par-priced fixed-rate bullet bonds, face 100, annual compounding. ONLY.
- No deposits, bills, FRAs, swaps, stubs, first/last irregular coupons, day counts,
  business-day calendars, non-annual coupon frequencies, interpolation, intermediate
  invented nodes, or market-data/feed integration of any kind.
- Up to the number of supplied nodes and no further.

## Hand-derived checks (tests, not captured output)
- 1Y at 5%: DF1 = 100/105 = 1/1.05; z1 = DF1^-1 - 1 = 0.05 exactly.
- 2Y at 6% behind 5%: 6*DF1 + 106*DF2 = 100 with DF1 = 1/1.05, so
  DF2 = (100 - 6/1.05)/106, which equals the bootstrap route (1 - 0.06/1.05)/1.06;
  both routes are asserted to agree, and z2 = DF2^(-1/2) - 1.
- 3Y at 6.5%: 6.5*DF1 + 6.5*DF2 + 106.5*DF3 = 100 with the two earlier factors, so
  DF3 = (100 - 6.5*(DF1+DF2))/106.5; the test asserts the 3y bond reprices to 100
  using the OUTPUT factors only, alongside the hand-route value, plus z3.
- Negative par yields above -1 (e.g. -1.0% one-year with -0.5% two-year) survive while
  all DFs stay positive; yields <= -1 are rejected outright.

## Files proposed for upstream change (not changed here)
- market/src/curve.mjs   (new)
- market/test/curve.test.mjs  (new)

## Verification recorded in WORK-STATUS.txt
Status: isolated prototype only; not merged into the canonical repository. Direct Node v24.22.1 array runs (do not rely on the builder reporter's printed totals) show workbench 51/51 (10 curve + 41 base) and canonical market 41/41, with SHA256 baseline re-verification of every copied file. See WORK-STATUS.txt Final direct verification for exact commands; the builder's anchored `^.. tests` regex printed 0 for the Unicode `ℹ tests` reporter and is superseded by the direct totals.