# Curve-bootstrap — Isolated Workbench Restore Manifest

Status: **isolated prototype only; not merged into the canonical repository. No production, deployment, or upstream-completion claim.** No commit or push performed. Canonical committed sources were not written to.

- Project source commit: `863cd4ddc06a61375ccc56d30ed9a8f4501873bf`
- Branch: `main`
- Workbench: `C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\workbench\curve-bootstrap`
- Canonical market (read-only reference): `C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\market`
- Node runtime: `v24.22.1` at `C:\Program Files\nodejs\node.exe`
- Git executable (exact): `C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\Git\cmd\git.exe`

## Formula and API

- API: `bootstrapParCurve(parQuotes)` from `src/curve.mjs`. Input: explicitly ordered annual par quotes `[{ tenorYears: 1, parYield: 0.05 }, ...]` with tenors exactly consecutive `1..n` in order. Output: one fresh node per quote, in input order: `{ tenorYears, parYield, discountFactor, annualEffectiveZeroRate }`.
- Par price identity (per the stated model): `100 = 100*c_n*(DF1 + ... + DF(n-1)) + 100*(1+c_n)*DFn` for a par bond of tenor n, face 100, annual coupons, par yield `c_n`.
- Bootstrap: `DFn = (1 - c_n * sum(DF1..DF(n-1))) / (1 + c_n)` with `DF1 = 1/(1+c_1)`.
- Zero rate: `z_n = DFn^(-1/n) - 1`.

## Scope and limits (prototype only)

- Annual-pay, par-priced, fixed-rate bullet bonds, face 100, annual compounding. ONLY.
- No deposits, bills, FRAs, swaps, stubs, first/last irregular coupons, day-count conventions, business-day calendars, non-annual coupon frequencies, interpolation, intermediate invented nodes, or market-data/feed integration of any kind.
- Up to the number of supplied nodes and no further. Tenor sequence enforced (no gaps/duplicates/sorting); `parYield` finite and `> -1`; empty/non-array rejected; non-positive/non-finite bootstrapped DF rejected; input never mutated; outputs fresh objects; function pure.
- No services, chain runtime, deployments, installs, or credential/state access. No state/ledger/`.env`/wallet/key/mnemonic files read.

## Build provenance (workbench only)

- Target was confirmed absent before builder-created files; builder copied and wrote only under `curve-bootstrap`: `src\curve.mjs`, `test\curve.test.mjs`, `PR-REVIEW.md`, `WORK-STATUS.txt`, `curve-run-workbench-latest.output.txt`, plus `package.json` and byte-copies of the 4 base files.
- Original references copied under `curve-bootstrap\recovery-tools\originals\` (byte-identical to home originals). Adapted builder in `curve-bootstrap\recovery-tools\adapted\curve-bootstrap-1.ps1` (parser 0, no `E:\NEXORA`, `$canon`/`$wb` set to the C paths above; `$wbFiles`/`$upFiles` explicit `Get-ChildItem` arrays; all writes are `$wb` children; canonical side is `Set-Location`/`Get-FileHash` read + test read only).

### Adaptations to the builder (workbench only; builder not rerun after test fixes)

- Guard fix: line 7 now aborts only if `$wb\src` or `$wb\test` exists, allowing `recovery-tools` root to exist without overwriting build folders. (First execution aborted exit 9 on the original `$wb` guard by construction.)
- Test runners changed from `'test/*.test.mjs'` glob to explicit file arrays: `$wbFiles = Get-ChildItem -LiteralPath "$wb\test" -Filter '*.test.mjs' | ForEach-Object { $_.FullName }` and analogous `$upFiles` for `$canon\test`. Logic/formula unchanged.
- Reporter regex fix (post-run, builder not rerun): anchored `'^.. tests (\d+)'` / `'^.. pass (\d+)'` / `'^.. fail (\d+)'` → unanchored `'tests\s+(\d+)'` / `'pass\s+(\d+)'` / `'fail\s+(\d+)'` in both workbench and upstream parsers, because Node v24 summary lines are `ℹ tests 51` and the anchored form printed `0`/blank. The builder's own run is therefore historical: it created files and reported `WBR tests=0 exit=1` / `UPPER tests= exit=0` with `HASH-CHECK: allCopiesStillIdentical=True`, while its output file shows 51/49/2 exit 1. **Do not claim builder exit 0.**

- Two test-expectation corrections in `test/curve.test.mjs` only (module formula/message semantics unchanged):
  1. Negative-yield case now genuinely uses `1Y -1%` (`q1=-0.01`) and `2Y -0.5%` (`q2=-0.005`; both `> -1`), with expected values derived from the stated formula: `df1 = 1/(1+q1)`, `df2 = (1 - q2*df1)/(1 + q2)`, `zero2 = df2^-0.5 - 1`. The as-built constant `0.9812639854846093` was stale for the old `+5%/+1%` quotes (true `DF2` for those quotes is `0.9806694955209807`, `zero2 = 0.00980767399616167`); the case no longer uses positive quotes to claim negative-yield coverage.
  2. Input-shape assertions changed to `/non-empty ordered array/` to match the TypeError actually thrown by `bootstrapParCurve` (`parQuotes must be a non-empty ordered array ...`).

## Copy identity and hashes (SHA-256)

Canonical market (identical to copied workbench bytes; recomputed post-run):

- `src\daycount.mjs` — `3E2E0E107ECF3BAADBCCEAFACC2C05B4723CD7B1326265570704B6B11BF1F3BE`
- `src\bond.mjs` — `40142C5B834EACF25477875C27D4B2CB366B729E69835AFD327CE19259F3BC68`
- `test\daycount.test.mjs` — `DAB218A1C18181E8031B3D0E745DA2938975B9E1E3B54086AEE2EC6109E16870`
- `package.json` — `D0D199F54BED5D5D686A2C51C67829C9526BBA86F0D1FCD0CBC5C7F362580646`

Assert: workbench copies equal canonical byte-for-byte; builder `HASH-CHECK: allCopiesStillIdentical=True`.

Workbench new files (post-correction):

- `src\curve.mjs` — `C9DE4E2EA25FC2FE03B2F51FDAAF3322BB9A2F59DFFD1194615BF452173113B5`
- `test\curve.test.mjs` — `22A922E41E66D7BAC60A231B36AC265F48799B2B9831B5115B2111D172C3CDA9`
- `recovery-tools\adapted\curve-bootstrap-1.ps1` — `DB528DD9AF80E4B32D579C7FF7CAC05F4A317C2FA3B8CA03C0AEC3652C718C82` (final, after guard/runner/reporter fixes)
- `PR-REVIEW.md` — `1F8792050136A4ED3FE69E4DD7FECCFF96B3E56ADEC1EEBE2977CB817F97FEB3`
- `WORK-STATUS.txt` — `12EC5C49CCF85F789D2B04671A9F13761693082E1344EA10E1940608378A0185`

Home originals (untouched; references in `recovery-tools\originals\` identical):

- `C:\Users\Administrator\scripts-icma\curve-bootstrap-1.ps1` — `42D9C532EA5A0173AF749BCE083169D5CDBEAFD8B2285D6C6D8395CB0C19DEFE`
- `C:\Users\Administrator\scripts-icma\patch-1.ps1` — `B94D6BEAE04C74710D5F47ECFEB71EFDAC95B6FC8636E7D8136750D47DC39BA8` (copied as reference only, **never executed**)

## Actual test totals (manual final Node runs, not builder exit)

- Workbench: **51 tests, 51 pass, 0 fail, exit 0** = 10 new curve cases + 41 copied base cases.
- Canonical market: **41 tests, 41 pass, 0 fail, exit 0**.
- Builder run (historical, superseded): created outputs but reported `0`/blank via the `^..` parser; direct output file shows 51/49/2 exit 1 — two failures now fixed as above. Builder not rerun.

Proposed upstream files if ever merged (not changed here): `market/src/curve.mjs` (new), `market/test/curve.test.mjs` (new).

## Staging note

`source\workbench\recovery-tools` is an extra staging directory created at the wrong level due to an initial root mistake (`source\workbench` rather than `source\workbench\curve-bootstrap`). It is **not** part of the official workbench deliverable. Official `recovery-tools` lives inside `curve-bootstrap\recovery-tools`. The wrong-level staging is kept for now; not deleted.

No commit/push, no upstream code modification, no service/runtime/network actions. Git checkout tracked tree untouched; `workbench/` untracked only.
