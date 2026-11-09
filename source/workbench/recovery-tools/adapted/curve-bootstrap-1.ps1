$ErrorActionPreference='Stop'
$canon='C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\market'
$wb='C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\workbench\curve-bootstrap'
$node='C:\Program Files\nodejs\node.exe'
$enc=[Text.UTF8Encoding]::new($false)

if(Test-Path -LiteralPath $wb){ Write-Output "ABORT: workbench already exists: $wb"; exit 9 }
New-Item -ItemType Directory -Force -Path "$wb\src" | Out-Null
New-Item -ItemType Directory -Force -Path "$wb\test" | Out-Null

# ------------------------------------------------- 1) byte-copy canonical market
$files=@('src\daycount.mjs','src\bond.mjs','test\daycount.test.mjs','package.json')
foreach($f in $files){
  Copy-Item -LiteralPath "$canon\$f" -Destination "$wb\$f"
}
'COPIED: canonical market -> workbench (4 files)'

# ------------------------------------------------- 2) baseline hashes
$baseline=@()
$hashTable=''
foreach($f in $files){
  $uh=(Get-FileHash -LiteralPath "$canon\$f" -Algorithm SHA256).Hash.ToLowerInvariant()
  $ch=(Get-FileHash -LiteralPath "$wb\$f" -Algorithm SHA256).Hash.ToLowerInvariant()
  $eq=($uh -eq $ch)
  $hashTable += "$f | $uh | $ch | $eq`n"
  if(-not $eq){ "COPY-MISMATCH: $f"; exit 10 }
  $baseline += @{ file=$f; upstream=$uh; workbench=$ch }
}
'BASELINE-HASHES: all 4 copies byte-identical to upstream'

# ------------------------------------------------- 3) src/curve.mjs
$curveSrc=@'
/**
 * Annual par-yield curve bootstrap.
 *
 * SCOPE, STATED PLAINLY
 * ---------------------
 * One narrow model: annual-pay, par-priced fixed-rate bullet bonds, face 100, annual
 * compounding. Node n exists only for tenor n = 1..maxTenor years. Nothing more: no
 * deposits, bills, FRAs, swaps, stubs, day-count conventions, calendars, non-annual
 * coupon frequencies, interpolation, invented intermediate nodes, or market-data access.
 *
 * INPUT CONTRACT
 * --------------
 * One explicitly ordered array of par quotes:
 *   [ { tenorYears: 1, parYield: 0.05 }, { tenorYears: 2, parYield: 0.06 }, ... ]
 * tenorYears must be the consecutive positive integers 1..n starting at 1, in order.
 * No gaps, no duplicates, no reordering - and the function never sorts for the caller.
 * parYield must be a finite number strictly greater than -1.
 *
 * BOOTSTRAP DEFINITION
 * --------------------
 * A par bond of tenor n at par yield c_n prices back to exactly 100:
 *     100 = 100 * c_n * (DF1 + ... + DF(n-1)) + 100 * (1 + c_n) * DFn
 * so, with the earlier annual coupon DFs already bootstrapped:
 *     DFn = (1 - c_n * sum(DF1..DF(n-1))) / (1 + c_n)
 * every node is therefore consistent with every earlier node, and with nothing not
 * stated here. The annual effective zero rate is the standard derivation
 *     z_n = DFn^(-1/n) - 1.
 */

/**
 * Bootstrap discount nodes from ordered annual par quotes.
 *
 * @param {Array<{tenorYears: number, parYield: number}>} parQuotes
 * @returns {Array<{tenorYears: number, parYield: number,
 *                  discountFactor: number, annualEffectiveZeroRate: number}>}
 */
export function bootstrapParCurve(parQuotes) {
  if (!Array.isArray(parQuotes) || parQuotes.length === 0) {
    throw new TypeError(
      'parQuotes must be a non-empty ordered array of { tenorYears, parYield } quotes'
    );
  }

  // Annuity of already-bootstrapped factors at each step (sum DF1..DF(n-1)).
  // Never written to the caller's array; every returned node is a fresh object.
  const nodes = [];
  let annuity = 0;

  for (let i = 0; i < parQuotes.length; i++) {
    const q = parQuotes[i];

    if (!q || typeof q !== 'object' ||
        typeof q.tenorYears !== 'number' || typeof q.parYield !== 'number') {
      throw new TypeError(
        'quote at index ' + i + ' must be an object with numeric tenorYears and parYield'
      );
    }
    if (!Number.isInteger(q.tenorYears) || q.tenorYears !== i + 1) {
      throw new RangeError(
        'tenorYears must be the consecutive positive integers starting at 1 ' +
        '(expected ' + (i + 1) + ', got ' + q.tenorYears + ' at index ' + i +
        '; no gaps, no duplicates, no reordering)'
      );
    }
    if (!Number.isFinite(q.parYield) || q.parYield <= -1) {
      throw new RangeError(
        'parYield at index ' + i + ' must be a finite number greater than -1: got ' +
        q.parYield
      );
    }

    const df = (1 - q.parYield * annuity) / (1 + q.parYield);

    if (!Number.isFinite(df) || df <= 0) {
      throw new RangeError(
        'bootstrapped discount factor at tenor ' + q.tenorYears +
        ' is not a positive finite number: ' + df
      );
    }

    nodes.push({
      tenorYears: i + 1,
      parYield: q.parYield,
      discountFactor: df,
      annualEffectiveZeroRate: Math.pow(df, -1 / (i + 1)) - 1,
    });
    annuity += df;
  }

  return nodes;
}
'@
[IO.File]::WriteAllText("$wb\src\curve.mjs",$curveSrc,$enc)
'WROTE src/curve.mjs'

# ------------------------------------------------- 4) test/curve.test.mjs
$testSrc=@'
/**
 * Par-yield curve bootstrap tests.
 *
 * Every expected value is hand-derived demand-side algebra for what the bootstrap
 * guarantees, not captured output: a par bond of tenor n must return exactly its face,
 * and where it does, the bootstrapped factors are whatever satisfies that identity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapParCurve } from '../src/curve.mjs';

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance,
    label + ': expected ~' + expected + ', received ' + actual);

const DF2_HAND = (100 - 6 * (1 / 1.05)) / 106;   // from 6*DF1 + 106*DF2 = 100
const DF3_HAND = (100 - 6.5 * ((1 / 1.05) + DF2_HAND)) / 106.5;

test('a one-year 5% par yield bootstraps to 1/1.05 and its own zero rate', () => {
  const nodes = bootstrapParCurve([{ tenorYears: 1, parYield: 0.05 }]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].tenorYears, 1);
  assert.equal(nodes[0].parYield, 0.05);
  near(nodes[0].discountFactor, 1 / 1.05, 1e-15, 'DF1');
  near(nodes[0].annualEffectiveZeroRate, 0.05, 1e-12, 'one-year zero equals its par yield');
});

test('a two-year 6% par yield bootstraps off the one-year factor', () => {
  const nodes = bootstrapParCurve([
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 2, parYield: 0.06 },
  ]);
  // Both hand routes must agree: the bootstrap identity and the par-price identity.
  near(nodes[1].discountFactor, (1 - 0.06 * (1 / 1.05)) / 1.06, 1e-14, 'bootstrap route');
  near(nodes[1].discountFactor, DF2_HAND, 1e-14, 'price route');
  near(nodes[1].annualEffectiveZeroRate, Math.pow(DF2_HAND, -1 / 2) - 1, 1e-12, 'zero2');
});

test('a three-node curve par-reprices every bond back to exactly 100', () => {
  const nodes = bootstrapParCurve([
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 2, parYield: 0.06 },
    { tenorYears: 3, parYield: 0.065 },
  ]);
  assert.equal(nodes.length, 3);
  // Each tenor reprices its OWN par bond to exactly face 100 using output factors only.
  near(nodes[0].discountFactor * 105, 100, 1e-12, '1y par bond');
  near(nodes[0].discountFactor * 6 + nodes[1].discountFactor * 106, 100, 1e-12, '2y par bond');
  near(nodes[0].discountFactor * 6.5 + nodes[1].discountFactor * 6.5
     + nodes[2].discountFactor * 106.5, 100, 1e-12, '3y par bond');
  // Hand-route values agree with the bootstrap outputs, and zeros are positive and finite.
  near(nodes[2].discountFactor, DF3_HAND, 1e-14, 'DF3');
  near(nodes[2].annualEffectiveZeroRate, Math.pow(DF3_HAND, -1 / 3) - 1, 1e-12, 'zero3');
  for (const n of nodes) {
    assert.ok(Number.isFinite(n.annualEffectiveZeroRate));
    assert.ok(n.discountFactor > 0 && n.discountFactor < 1);
  }
});

test('negative par yields above -1 are valid while factors stay positive', () => {
  const nodes = bootstrapParCurve([
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 2, parYield: 0.01 },
  ]);
  near(nodes[1].discountFactor, (1 - 0.01 * (1 / 1.05)) / 1.01, 1e-14, 'DF2 stays positive');
  near(nodes[1].annualEffectiveZeroRate, Math.pow(0.9812639854846093, -0.5) - 1, 1e-9, 'zero2');
});

test('input shape and emptiness are rejected, never coerced', () => {
  assert.throws(() => bootstrapParCurve([]), /non-empty array/);
  assert.throws(() => bootstrapParCurve('nope'), /non-empty array/);
  assert.throws(() => bootstrapParCurve(null), /non-empty array/);
  assert.throws(() => bootstrapParCurve(6), /non-empty array/);
});

test('tenorYears sequence is enforced exactly: gaps, order, duplicates, integers', () => {
  // Gap: 1 then 3 (expected 2).
  assert.throws(() => bootstrapParCurve([
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 3, parYield: 0.06 },
  ]), /expected 2/);
  // Unsorted: 2 then 1 (expected 1 at index 0) - never silently sorted.
  assert.throws(() => bootstrapParCurve([
    { tenorYears: 2, parYield: 0.06 },
    { tenorYears: 1, parYield: 0.05 },
  ]), /expected 1/);
  // Duplicate: 1 then 1 (expected 2).
  assert.throws(() => bootstrapParCurve([
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 1, parYield: 0.05 },
  ]), /expected 2/);
  // Fractional tenor is not an integer.
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1.5, parYield: 0.05 }]), /integers/);
  // Tenor 0 / negative tenor are not positive integers.
  assert.throws(() => bootstrapParCurve([{ tenorYears: 0, parYield: 0.05 }]), /integers/);
});

test('parYield must be finite and strictly greater than -1', () => {
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1, parYield: -1 }]), /greater than -1/);
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1, parYield: -1.5 }]), /greater than -1/);
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1, parYield: NaN }]), /finite/);
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1, parYield: Infinity }]), /finite/);
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1, parYield: '0.05' }]), /numeric/);
  assert.throws(() => bootstrapParCurve([{ tenorYears: 1 }]), /numeric/);
  assert.throws(() => bootstrapParCurve([{ parYield: 0.05 }]), /numeric/);
  assert.throws(() => bootstrapParCurve([null]), /numeric/);
});

test('a par quote that bootstraps to a non-positive discount factor is rejected', () => {
  // With DF1 = 1/1.05, a 110% two-year par coupon needs a negative or zero DF2.
  assert.throws(() => bootstrapParCurve([
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 2, parYield: 1.1 },
  ]), /tenor 2/);
});

test('inputs are not mutated and outputs are fresh objects', () => {
  const input = [
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 2, parYield: 0.06 },
    { tenorYears: 3, parYield: 0.065 },
  ];
  const snapshot = JSON.parse(JSON.stringify(input));
  const nodes = bootstrapParCurve(input);
  assert.deepEqual(input, snapshot, 'caller input must be untouched');
  assert.notStrictEqual(nodes[0], input[0], 'outputs are fresh nodes');
});

test('bootstrapping is deterministic for identical inputs', () => {
  const quotes = [
    { tenorYears: 1, parYield: 0.05 },
    { tenorYears: 2, parYield: 0.06 },
    { tenorYears: 3, parYield: 0.065 },
  ];
  assert.deepEqual(bootstrapParCurve(quotes), bootstrapParCurve(quotes));
});
'@
[IO.File]::WriteAllText("$wb\test\curve.test.mjs",$testSrc,$enc)
'WROTE test/curve.test.mjs'

# ------------------------------------------------- 5) PR-REVIEW.md
$pr=@'
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
    6.5 ... c_n * (DF1 + ... + DF(n-1)) + (1 + c_n) * DFn = 1             (per unit face)
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
- Negative par yields above -1 (e.g. 1% two-year behind 5% one-year) survive while
  all DFs stay positive; yields <= -1 are rejected outright.

## Files proposed for upstream change (not changed here)
- market/src/curve.mjs   (new)
- market/test/curve.test.mjs  (new)

## Verification recorded in WORK-STATUS.txt
Workbench suite (legacy 41 + curve), upstream market suite rerun (41), and SHA256
baseline re-verification of every copied file. Exact counts and exits are recorded in
WORK-STATUS.txt in this workbench.
'@
[IO.File]::WriteAllText("$wb\PR-REVIEW.md",$pr,$enc)
'WROTE PR-REVIEW.md'

# ------------------------------------------------- 6) WORK-STATUS.txt (baseline)
$status=@"
# Curve bootstrap isolated workbench baseline
Created: $(Get-Date -Format o)
Canonical source: C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\market
Workbench: C:\Users\Administrator\NEXORA-ANEX-REBUILT\source\workbench\curve-bootstrap
Canonical source was copied, not edited.

Relative path | canonical upstream SHA256 | workbench SHA256 | identical
$hashTable
Baseline hash rule: copied files must stay byte-identical for the whole session.
New workbench-only files: src/curve.mjs, test/curve.test.mjs, PR-REVIEW.md, WORK-STATUS.txt.
Node executable: $node
Implementation status: baseline created; curve module and tests written this run.
"@
[IO.File]::WriteAllText("$wb\WORK-STATUS.txt",$status,$enc)
'WROTE WORK-STATUS.txt (baseline)'

# ------------------------------------------------- 7) run workbench suite
Set-Location $wb
"node: $(& $node --version)"
$wbFiles = Get-ChildItem -LiteralPath "$wb\test" -Filter '*.test.mjs' | ForEach-Object { $_.FullName }
$wbOut = & $node --test $wbFiles 2>&1 | Out-String
$wbExit=$LASTEXITCODE
"$wbOut" | Set-Content "$wb\curve-run-workbench-latest.output.txt" -Encoding UTF8
$nt  = [regex]::Match($wbOut,'^.. tests (\d+)','Multiline')
$np  = [regex]::Match($wbOut,'^.. pass (\d+)','Multiline')
$nf  = [regex]::Match($wbOut,'^.. fail (\d+)','Multiline')
$ntest=if($nt.Groups[1].Value){$nt.Groups[1].Value}else{0}
$npass=if($np.Groups[1].Value){$np.Groups[1].Value}else{0}
$nfail=if($nf.Groups[1].Value){$nf.Groups[1].Value}else{0}
"WBR tests=$ntest pass=$npass fail=$nfail exit=$wbExit"

# ------------------------------------------------- 8) run canonical upstream suite
Set-Location $canon
$upOut = & $node --test 'test/*.test.mjs' 2>&1 | Out-String
$upExit=$LASTEXITCODE
$unt=([regex]::Match($upOut,'^.. tests (\d+)','Multiline').Groups[1].Value)
$unp=([regex]::Match($upOut,'^.. pass (\d+)','Multiline').Groups[1].Value)
$unf=([regex]::Match($upOut,'^.. fail (\d+)','Multiline').Groups[1].Value)
"UPPER tests=$unt pass=$unp fail=$unf exit=$upExit"

# ------------------------------------------------- 9) re-verify copied hashes
$stillIdentical=$true
$recheckTable=''
foreach($b in $baseline){
  $uh=(Get-FileHash -LiteralPath "$canon\$($b.file)" -Algorithm SHA256).Hash.ToLowerInvariant()
  $ch=(Get-FileHash -LiteralPath "$wb\$($b.file)" -Algorithm SHA256).Hash.ToLowerInvariant()
  $eq=($uh -eq $ch -and $uh -eq $b.upstream)
  if(-not $eq){ $stillIdentical=$false }
  $recheckTable += "$($b.file) | post-run-identical=$eq`n"
}
"HASH-CHECK: allCopiesStillIdentical=$stillIdentical"

# ------------------------------------------------- 10) append results to WORK-STATUS
$tail=@"

## Verification run (recorded by the runner script, $(Get-Date -Format o))
Command (workbench): node --test 'test/*.test.mjs'  -> tests=$ntest pass=$npass fail=$nfail exit=$wbExit
Command (canonical upstream market): node --test 'test/*.test.mjs' -> tests=$unt pass=$unp fail=$unf exit=$upExit
Copied-file hash re-verification after runs (all must be True):
$recheckTable
stillIdentical=$stillIdentical
Rule kept: canonical upstream, GitHub and Market Data Hub untouched; no push/commit.
"@
[IO.File]::AppendAllText("$wb\WORK-STATUS.txt",$tail,$enc)

$overall=if($wbExit -ne 0){$wbExit}elseif($upExit -ne 0){$upExit}elseif(-not $stillIdentical){50}else{0}
exit $overall
