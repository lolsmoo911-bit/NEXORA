# PR-style review: ACT/ACT ICMA (isolated prototype)

Status: prototype only; not merged into the canonical repository.

## API
- icmaDayCountFraction(referencePeriods, frequency, start, end) requires an explicit non-empty array of { start, end } coupon reference periods and frequency 1, 2, or 4.
- dayCountFraction(start, end, 'ACT/ACT ICMA', { referencePeriods, frequency }) delegates to the schedule-aware implementation. A two-date ICMA call without the schedule is rejected.
- Bond objects using dayCount: 'ACT/ACT ICMA' must include referencePeriods. The schedule must be regular, contiguous, cover the bond to maturity, and match backward-generated coupon boundaries.

## Mathematical definition
For each reference period i, let D_i be its actual calendar-day length, f the coupon frequency, and O_i the actual overlap days between the requested interval and that period. The year fraction is:

sum_i O_i / (f * D_i)

All intervals are half-open [start, end); dates are strict UTC calendar dates.

## Hand-derived checks
- Full annual period: 366 / (1 * 366) = 1.
- Full semiannual period: 182 / (2 * 182) = 1/2.
- Full quarterly period: 91 / (4 * 91) = 1/4.
- 2020-07-02 to 2022-07-02: 183/366 + 1 + 182/365.
- EOM periods 2019-08-31 to 2020-02-29 (182 days) and 2020-02-29 to 2020-08-31 (184 days): each semiannual fraction is 1/2.
- Bond example, 2020-04-01 settlement: 91 elapsed days in a 182-day semiannual coupon period; accrued coupon = 3 * 91/182 = 1.5. Dirty price uses 1/4 and 3/4 years for remaining cashflows.

## Deliberate limitations
- Only ACT/ACT ICMA; not bare ACT/ACT, ACT/ACT ISDA, AFB, or a generic Treasury alias.
- Regular reference periods only. Stubs and irregular first/last coupons are rejected, not inferred.
- No ex-coupon rules, business-day calendars, floating-rate or amortizing instruments.
- This is fixed-income arithmetic only; no market quotes, live feeds, portfolio holdings, order execution or trading.

## Proposed upstream files (not changed here)
- market/src/daycount.mjs
- market/src/bond.mjs
- market/test/daycount.test.mjs
- market/test/act-act-icma.test.mjs
- market/README.md or fixed-income convention documentation.

The canonical upstream-nexora files, GitHub repository and Market Data Hub are intentionally untouched.