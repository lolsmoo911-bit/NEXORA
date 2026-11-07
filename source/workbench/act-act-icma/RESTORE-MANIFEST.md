# ACT/ACT ICMA — Isolated Workbench Restore Manifest

Status: **isolated prototype only; not merged into the canonical repository. No production, deployment, or upstream-completion claim.** No commit or push performed. Canonical committed sources were not written to.

Workbench: `C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\workbench\act-act-icma`
Canonical market (read-only reference): `C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\market`
Node runtime: `v24.22.1` at `C:\Program Files\nodejs\node.exe`
Git executable (exact): `C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\Git\cmd\git.exe`

## Source commit and tracked-tree state

- Branch: `main`
- HEAD: `863cd4ddc06a61375ccc56d30ed9a8f4501873bf`
- `git -C 'C:\Users\Administrator\NEXORA-ANEX-REBUILT\source' status --short` after all runs:
  ```
  ?? workbench/
  ```
  Tracked tree clean; only untracked `workbench/` present as expected.

## Canonical source hashes (pre-run and post-run; unchanged)

SHA-256 of `source\market` verified before copy and recomputed after all edits:

- `src\daycount.mjs` — `3E2E0E107ECF3BAADBCCEAFACC2C05B4723CD7B1326265570704B6B11BF1F3BE`
- `src\bond.mjs` — `40142C5B834EACF25477875C27D4B2CB366B729E69835AFD327CE19259F3BC68`
- `test\daycount.test.mjs` — `DAB218A1C18181E8031B3D0E745DA2938975B9E1E3B54086AEE2EC6109E16870`
- `package.json` — `D0D199F54BED5D5D686A2C51C67829C9526BBA86F0D1FCD0CBC5C7F362580646`

Assert: post-run values above are identical to pre-run. Source market was never written to.

## Workbench build

- Target `...\source\workbench\act-act-icma` was confirmed absent (`Test-Path False`) before any create.
- Byte-copied the four files above from `source\market` into `workbench\act-act-icma` (`src\`, `test\`, `package.json`).
- Original helpers copied to `recovery-tools\` as read-only references (byte-identical to home originals, `IsReadOnly=True`); home originals untouched:
  - `C:\Users\Administrator\apply-act-act-icma.ps1` — `DF3C3EBCAB9368CF622FEF31D19483340A4483DBAEEBBDBBD4110176B6D0F2BD`
  - `C:\Users\Administrator\scripts-icma\patch-1.ps1` — `B94D6BEAE04C74710D5F47ECFEB71EFDAC95B6FC8636E7D8136750D47DC39BA8`
  - `C:\Users\Administrator\finish-act-act-icma-tests.ps1` — `3A75BE0956E341C8540F6D859BDC74B5A121AE054974B1EB6D9F29FB379C8292`
- Adapted copies in `recovery-tools\adapted\` with `E:\NEXORA-ANEX-REBUILT\workbench\act-act-icma` → `C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\workbench\act-act-icma` and `E:\NEXORA-ANEX-REBUILT\upstream-nexora\market` → `C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\market`. Verified zero remaining `E:\NEXORA` paths and writes only to `$work`/`$wb` under the C workbench (upstream use in `patch-1` is test-run + hash-read only).
- Adapted script hashes (final, post newline-fix):
  - `recovery-tools\adapted\apply-act-act-icma.ps1` — `C66C3EA4B564882135716708EA5BB3ABD78035AB19389CED8700219C4340367B`
  - `recovery-tools\adapted\patch-1.ps1` — `0033C000B1E2905CE941AD23060CD7D892F6BA520EE4FB553B19739352A522D0`
  - `recovery-tools\adapted\finish-act-act-icma-tests.ps1` — `AE998D3472298D9A928DA00D8B32370FE3D51BEBF7356B8A15457DE460FFB299` (inspected, **not run** — it overwrites `test\act-act-icma.test.mjs` with 15 tests and would drop the 3 regression tests)
  - `finish-act-act-icma.ps1` was not used (prior audit found undefined `$icmaTestPath`; not required).
- `finish-act-act-icma-tests.ps1` write-target inspection: only `$testPath`/`PR-REVIEW.md`/`WORK-STATUS.txt` under `$work`; would overwrite the ICMA suite, so deliberately excluded from execution.

### Line-ending repair (workbench-only, adapted apply only)

Original helper reads CRLF market files but searches LF here-strings (`CONTAINS_RAW=False`, `CONTAINS_NORMALIZED=True`):
- First attempt failed at `BOND_DIRTY_PRICE_BLOCK_NOT_FOUND` (line 222) after writing only `src\daycount.mjs`; `bond.mjs`/tests/package stayed pristine.
- Second failure after LF normalization was `BOND_ROUNDTRIP_ANCHOR_NOT_FOUND` (line 142): `$oldRound`/`$newRound` used `[Environment]::NewLine` (CRLF 13,10) against LF-normalized `$bond`.
- Final adapted apply normalization (all 8 tokens, lines 123/124/140/141 → `[string][char]10`; grep for `[Environment]::NewLine` returns zero; parser errors 0):
  - `$day = ([System.IO.File]::ReadAllText($dayPath)) -replace "`r", ""`
  - `$bond = ([System.IO.File]::ReadAllText($bondPath)) -replace "`r", ""`
  - `$legacy = ([System.IO.File]::ReadAllText($legacyTestPath)) -replace "`r", ""`
  - Every `[Environment]::NewLine` → `[string][char]10` (LF)
- `daycount.mjs` was reset byte-identical from canonical source before each retry so apply started from clean base.

### Semantic fixes after apply+patch (workbench only; patch-1 not re-run)

Initial apply+patch run (exit 0 apply, patch exit 1 due to 2 test failures) left 59 tests with 57 pass / 2 fail. Two minimal fixes applied, no other code changes, no test-file changes in this phase:

A) `src\daycount.mjs` — `icmaDayCountFraction`: swapped validation order so non-empty `referencePeriods` check (existing `TypeError` message preserved) runs **before** `frequency` check. Bare `dayCountFraction(..., 'ACT/ACT ICMA')` without options now fails with `referencePeriods` as the test expects (previously `unsupported ICMA frequency: undefined`).

B) `src\bond.mjs` — `schedule()`: imported `isLastDayOfMonth` from `daycount.mjs`; backward step now preserves EOM anchor: remember `isMonthEnd = isLastDayOfMonth(d)`, compute `previous = addMonths(d, -step, bond.eom || 'limit')`, if EOM snap `previous` to `new Date(Date.UTC(previous.getUTCFullYear(), previous.getUTCMonth()+1, 0))`, then `d = previous`. Restores `2020-02-29 → 2019-08-31` (was `2019-08-29`) so caller-supplied `2019-08-31` matches `generated.previous` millis. Non-EOM behavior, backward generation, and validation unchanged.

Post-fix workbench hashes (SHA-256):
- `src\daycount.mjs` — `026D4958D79EF2CB1AE905F1E5D33618048D92DEC70AC46BBA9B3ED8003F7E30`
- `src\bond.mjs` — `97FA2F0C771E3E3B1DBE28F3BCF193FF96AC4B31858A2B8B93C58E9EB3C3A90F`
- `test\daycount.test.mjs` — `79986385D81791BDF014D644634591ED35386DF1DBFC9E43563DB71EDB532183` (legacy ACT/ACT ICMA assertion updated by apply)
- `test\act-act-icma.test.mjs` — `7108912851976B61031FA600E3022BF57AB789D7DCD58A42FB7C8F011C6B3D15` (15 apply tests + 3 `IRICMA-REGRESSION` tests appended by patch-1)
- `package.json` — `D0D199F54BED5D5D686A2C51C67829C9526BBA86F0D1FCD0CBC5C7F362580646` (canonical, unchanged)

Note: adapted `patch-1` lines 203–207 contain historical expected hashes (`87b16de...`, `012f511...`, `d44e8fb...`, `5c70a44...`) that differ from current base hashes. Audit confirmed they are **report-only** (`HASH ... upstream=False` print) and **do not** affect exit: `exit $overall` (lines 218–219) uses only workbench/upstream test exit codes. Left unaltered per instruction.

## Exact commands

```powershell
Test-Path -LiteralPath 'C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\workbench\act-act-icma'  # False (absent)
Get-FileHash -Algorithm SHA256 -LiteralPath '...\source\market\src\daycount.mjs','...\source\market\src\bond.mjs','...\source\market\test\daycount.test.mjs','...\source\market\package.json'
& 'C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\Git\cmd\git.exe' -C 'C:\Users\Administrator\NEXORA-ANEX-REBUILT\source' rev-parse HEAD
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\workbench\act-act-icma\recovery-tools\adapted\apply-act-act-icma.ps1'
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\workbench\act-act-icma\recovery-tools\adapted\patch-1.ps1'
Set-Location -LiteralPath 'C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\workbench\act-act-icma'; $node='C:\Program Files\nodejs\node.exe'; $files = Get-ChildItem test -Filter '*.test.mjs' | ForEach-Object { $_.FullName }; & $node --test $files
Set-Location -LiteralPath 'C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\market'; $node='C:\Program Files\nodejs\node.exe'; $files = Get-ChildItem test -Filter '*.test.mjs' | ForEach-Object { $_.FullName }; & $node --test $files
```

(Note: `C:\Program Files\WindowsPowerShell\v1.0\powershell.exe` does not exist on this host; the correct full path `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` was used. Machine execution policy was never altered.)

## Test results (Node v24.22.1, actual totals)

Workbench (explicit array `$files`): **59 tests, 59 pass, 0 fail, exit 0** = 18 ICMA (15 initial + 3 regression) + 41 legacy (daycount + bond).

Canonical market (explicit array): **41 tests, 41 pass, 0 fail, exit 0**.

Pre-fix workbench for reference: 59 / 57 / 2 fail, exit 1 —
- `backward-generated EOM schedule matches caller-supplied leap February periods` (`RangeError: does not include previous coupon boundary`)
- `ACT/ACT is refused rather than approximated` (`unsupported ICMA frequency: undefined` vs expected `/referencePeriods/`)
Both pass after fixes A and B above.

## Scope and limitations (prototype only)

- ACT/ACT ICMA regular coupons only; `icmaDayCountFraction(referencePeriods, frequency, start, end)` requires explicit non-empty `{start,end}` schedule, frequency 1/2/4, strict `YYYY-MM-DD` strings, contiguous regular periods.
- **No stubs / irregular first/last coupons** (rejected, not inferred).
- **Bare ACT/ACT, ACT/ACT ISDA, AFB not implemented** and deliberately distinct from ACT/ACT ICMA; no US Treasury-convention alias claim.
- **No ex-coupon rules, business-day calendars, holidays, floating-rate, amortizing, callable, convertible instruments.**
- Fixed-income arithmetic only; no market quotes, live feeds, holdings, execution, or trading.
- No services, tunnels, DNS, WARP, chain runtime, deployments, or installs performed. No state/ledger/`.env`/wallet/key/mnemonic files read.

Proposed upstream files if ever merged (not changed here): `market/src/daycount.mjs`, `market/src/bond.mjs`, `market/test/daycount.test.mjs`, `market/test/act-act-icma.test.mjs`, plus convention docs. Canonical repo untouched.
