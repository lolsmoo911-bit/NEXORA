$ErrorActionPreference='Stop'
$wb='E:\NEXORA-ANEX-REBUILT\workbench\act-act-icma'
$enc=[Text.UTF8Encoding]::new($false)
$node='C:\Program Files\nodejs\node.exe'

# --------------------------------------------------------- 1) src/daycount.mjs
$p1="$wb\src\daycount.mjs"
$s=([IO.File]::ReadAllText($p1)) -replace "`r",""
$h='export function icmaDayCountFraction'
$tail=' * Year fraction between two dates under a convention.'
$i=$s.IndexOf($h)
$j=$s.IndexOf($tail)
if($i -lt 0 -or $j -lt 0){ 'MARKER-FAIL-daycount'; exit 11 }
$k=$s.LastIndexOf('/**',$j)
if($k -le $i){ 'MARKER2-FAIL'; exit 11 }
$new=@'
export function icmaDayCountFraction(referencePeriods, frequency, start, end) {
  if (![1, 2, 4].includes(frequency)) {
    throw new RangeError('unsupported ICMA frequency: ' + frequency);
  }
  if (!Array.isArray(referencePeriods) || referencePeriods.length === 0) {
    throw new TypeError('ACT/ACT ICMA requires a non-empty explicit referencePeriods array');
  }

  // ICMA inputs are strict: a bare YYYY-MM-DD string. This is stricter than the generic
  // parser, which still accepts Date objects for the other conventions; the ICMA gate
  // needs strings so a schedule can never smuggle in a time-of-day or an implicit zone.
  const asUtcDate = (value, label) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new TypeError(label + ' must be a YYYY-MM-DD string');
    }
    return parseDate(value);
  };

  // Phase 1: parse every period and require a positive length, so a zero-length or
  // reversed period is reported as exactly that, wherever it sits.
  const normalized = referencePeriods.map((period, index) => {
    if (!period || typeof period !== 'object' ||
        period.start === undefined || period.end === undefined) {
      throw new TypeError('reference period ' + index + ' must contain start and end');
    }
    const periodStart = asUtcDate(period.start, 'referencePeriods[' + index + '].start');
    const periodEnd = asUtcDate(period.end, 'referencePeriods[' + index + '].end');
    const days = daysBetween(periodStart, periodEnd);
    if (days <= 0) {
      throw new RangeError(days === 0
        ? 'reference period ' + index + ' has zero length'
        : 'reference period ' + index + ' end precedes start');
    }
    return { start: periodStart, end: periodEnd, days };
  });

  // Phase 2: adjacency, schedule-wide. Every neighbour pair must touch exactly - no gap,
  // no overlap - before any period is judged on its shape. An input whose first real
  // defect is an overlap must never be told "irregular" instead.
  for (let i = 1; i < normalized.length; i++) {
    const delta = daysBetween(normalized[i - 1].end, normalized[i].start);
    if (delta > 0) {
      throw new RangeError('gap of ' + delta + ' day(s) before reference period ' + i);
    }
    if (delta < 0) {
      throw new RangeError('reference period ' + (i - 1) + ' overlaps period ' + i);
    }
  }

  // Phase 3: shape, schedule-wide. Each period spans exactly 12/frequency months and is
  // anchored on the same day of month, or on the last day of BOTH months. One-sided EOM
  // anchors (31 Jan closing to 30 Jul) are stubs and are rejected wherever they sit.
  for (let i = 0; i < normalized.length; i++) {
    const period = normalized[i];
    const monthDelta =
      (period.end.getUTCFullYear() - period.start.getUTCFullYear()) * 12 +
      (period.end.getUTCMonth() - period.start.getUTCMonth());
    const regularDates =
      period.start.getUTCDate() === period.end.getUTCDate() ||
      (isLastDayOfMonth(period.start) && isLastDayOfMonth(period.end));
    if (monthDelta !== 12 / frequency || !regularDates) {
      throw new RangeError(
        'irregular ACT/ACT ICMA reference period ' + i + '; stubs are not supported'
      );
    }
  }

  // Phase 4: the measured interval - ordered, inside schedule coverage, then summed.
  const a = asUtcDate(start, 'start');
  const b = asUtcDate(end, 'end');
  if (daysBetween(a, b) < 0) throw new RangeError('end precedes start');
  const first = normalized[0].start;
  const last = normalized[normalized.length - 1].end;
  if (daysBetween(first, a) < 0 || daysBetween(a, last) < 0) {
    throw new RangeError('start is outside ACT/ACT ICMA reference schedule coverage');
  }
  if (daysBetween(first, b) < 0 || daysBetween(b, last) < 0) {
    throw new RangeError('end is outside ACT/ACT ICMA reference schedule coverage');
  }
  let fraction = 0;
  for (const period of normalized) {
    const overlapStart = a > period.start ? a : period.start;
    const overlapEnd = b < period.end ? b : period.end;
    const overlapDays = daysBetween(overlapStart, overlapEnd);
    if (overlapDays > 0) {
      fraction += overlapDays / (frequency * period.days);
    }
  }
  return fraction;
}
'@
$s=$s.Substring(0,$i)+$new.TrimEnd()+"`n"+$s.Substring($k)
$needle='return icmaDayCountFraction(options.referencePeriods, options.frequency, a, b);'
$cn=([regex]::Matches($s,[regex]::Escape($needle))).Count
if($cn -ne 1){ "DCK-BRANCH-COUNT=$cn"; exit 12 }
$s=$s.Replace($needle,'return icmaDayCountFraction(options.referencePeriods, options.frequency, start, end);')
[IO.File]::WriteAllText($p1,$s,$enc)
'DAYCOUNT-PATCHED'

# --------------------------------------------------------- 2) src/bond.mjs
$p2="$wb\src\bond.mjs"
$b=([IO.File]::ReadAllText($p2)) -replace "`r",""
$patches=@(
 @("`n  const firstStart = parseDate(supplied[0].start);",""),
 @('icmaDayCountFraction(supplied, bond.frequency, firstStart, finalEnd);','icmaDayCountFraction(supplied, bond.frequency, supplied[0].start, supplied[supplied.length - 1].end);'),
 @('return dayCountFraction(start, end, bond.dayCount, {','return dayCountFraction(isoDate(start), isoDate(end), bond.dayCount, {'),
 @("dayCountFraction, daysBetween, assertSupportedConvention, icmaDayCountFraction } from './daycount.mjs';","dayCountFraction, daysBetween, assertSupportedConvention, icmaDayCountFraction } from './daycount.mjs';`n`n/** Serialize a UTC-midnight Date to YYYY-MM-DD for the strict ICMA date gate. */`nconst isoDate = (d) => d.toISOString().slice(0, 10);")
)
foreach($pt in $patches){
  $cnt=([regex]::Matches($b,[regex]::Escape($pt[0]))).Count
  if($cnt -ne 1){ "BOND-NEEDLE-COUNT=$cnt :: "+($pt[0].Substring(0,[Math]::Min(50,$pt[0].Length))); exit 13 }
  $b=$b.Replace($pt[0],$pt[1])
}
[IO.File]::WriteAllText($p2,$b,$enc)
'BOND-PATCHED'

# --------------------------------------------------------- 3) regression tests
$p3="$wb\test\act-act-icma.test.mjs"
$tb=[IO.File]::ReadAllText($p3)
if($tb -match 'IRICMA-REGRESSION'){ 'ALREADY-APPENDED' } else {
$block=@'

// ============ IRICMA-REGRESSION: order, EOM rule, strict date strings ============
test('adjacency defects are reported before irregular shape', () => {
  // 30 Jul start overlaps the 31 Jul end AND is one-sided-EOM irregular; the overlap
  // in a neighbour pair must be the reported defect, not "irregular".
  assert.throws(() => icmaDayCountFraction([
      { start: '2019-01-31', end: '2019-07-31' },
      { start: '2019-07-30', end: '2020-01-31' },
    ], 2, '2019-01-31', '2020-01-31'), /overlap/);
  // A later, also-irregular period still reports its gap first.
  assert.throws(() => icmaDayCountFraction([
      { start: '2020-01-01', end: '2020-07-01' },
      { start: '2020-07-02', end: '2020-12-15' },
    ], 2, '2020-01-01', '2020-12-15'), /gap/);
});

test('EOM regularity requires both ends to be month ends', () => {
  // 31 Jan -> 30 Jul: month delta 6 but only the start is a month end - a stub, rejected.
  assert.throws(() => icmaDayCountFraction(
    [{ start: '2020-01-31', end: '2020-07-30' }], 2, '2020-01-31', '2020-07-30'),
    /irregular/);
  // 31 Jan -> 31 Jul: both ends are month ends - a regular coupon, accepted.
  near(icmaDayCountFraction(
    [{ start: '2019-01-31', end: '2019-07-31' }], 2, '2019-01-31', '2019-07-31'), 0.5);
});

test('ICMA date inputs must be strict YYYY-MM-DD strings', () => {
  const p = [{ start: '2020-01-01', end: '2020-07-01' }];
  assert.throws(() => icmaDayCountFraction(p, 2, parseDate('2020-01-01'), '2020-07-01'),
    /YYYY-MM-DD string/);
  assert.throws(() => icmaDayCountFraction(
    [{ start: parseDate('2020-01-01'), end: '2020-07-01' }], 2, '2020-01-01', '2020-07-01'),
    /YYYY-MM-DD string/);
  assert.throws(() => dayCountFraction(parseDate('2020-01-01'), parseDate('2020-07-01'),
    'ACT/ACT ICMA', { referencePeriods: p, frequency: 2 }), /YYYY-MM-DD string/);
});
'@
[IO.File]::AppendAllText($p3,$block,$enc)
'REGRESSION-TESTS-APPENDED'
}

# --------------------------------------------------------- 4) workbench suite
"nodeVersion: $(& $node --version)"
Set-Location $wb
$tapText = & $node --test 'test/*.test.mjs' 2>&1 | Out-String
$code=$LASTEXITCODE
"$tapText" | Set-Content "$wb\icma-run-latest.output.txt" -Encoding UTF8
$ntest=[regex]::Match($tapText,'^.. tests (\d+)','Multiline').Groups[1].Value
$npass=[regex]::Match($tapText,'^.. pass (\d+)','Multiline').Groups[1].Value
$nfail=[regex]::Match($tapText,'^.. fail (\d+)','Multiline').Groups[1].Value
"WB tests=$ntest pass=$npass fail=$nfail exit=$code"
if($nfail -gt 0){
  $lines=$tapText -split "`n"
  $lines | Select-String -Pattern 'fail (\d)|^.*✖ ' | Select-Object -First 10 | ForEach-Object { $_.Line.Trim() }
}

# --------------------------------------------------------- 5) upstream rerun + hashes
Set-Location 'E:\NEXORA-ANEX-REBUILT\upstream-nexora\market'
$utap = & $node --test 'test/*.test.mjs' 2>&1 | Out-String
$ucode=$LASTEXITCODE
$unt=[regex]::Match($utap,'^.. tests (\d+)','Multiline').Groups[1].Value
$unp=[regex]::Match($utap,'^.. pass (\d+)','Multiline').Groups[1].Value
$unf=[regex]::Match($utap,'^.. fail (\d+)','Multiline').Groups[1].Value
"UP tests=$unt pass=$unp fail=$unf exit=$ucode"

$expect=@{
 'src\daycount.mjs'      ='87b16de13b0880ce5994f68874b65e51873ab732eb3a98313e31d63dd64ede49'
 'src\bond.mjs'          ='012f511bd71a96eafc3830310831c3a342510e4d2b27cb76635933ebd955de25'
 'test\daycount.test.mjs'='d44e8fb73aa746b1792509fb5f0472a4967be6bb0d8515cf5f53bc8a47fd6933'
 'package.json'          ='5c70a441d948557df1be211c86b86f7e02693152697206cef7790252c41e866b'
}
$src='E:\NEXORA-ANEX-REBUILT\upstream-nexora\market'
foreach($k in $expect.Keys){
  $u=[IO.File]::ReadAllBytes("$src\$k")
  $sha=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($u)).Replace('-','').ToLowerInvariant()
  "HASH $k upstream=$(($sha -eq $expect[$k]))"
  $wbk="$wb\$k"
  $wsha=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($wbk))).Replace('-','').ToLowerInvariant()
  "HASH $k (workbench, may have evolved) = $wsha"
}
$overall=if($code -ne 0){$code}elseif($ucode -ne 0){$ucode}else{0}
exit $overall
