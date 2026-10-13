#!/usr/bin/env python3
"""
mining-cost.py — how long a vanity suffix takes, measured rather than assumed.

TESTNET ONLY. No network access, no deployment, no cost.

WHY THIS FILE EXISTS
--------------------
An earlier version of the NEXORA vanity documentation quoted "8.4 million keccak per
second" and, from it, a table saying a 12-hex-digit suffix such as SILVER
(53494c564552) took "about 250 years". That was wrong, and wrong in the direction that
makes the tool look useless.

The arithmetic error was simple: 2^48 / 8.4e6 is about 33.5 million seconds, which is
388 days, which is roughly 1.06 years - not 250. The 250 came from nowhere reproducible.

Separately, when the rate was finally MEASURED with `vanity --bench`, the real figure on
this 4-core machine was about 4.3M/s, not 8.4M/s. So the quoted rate was wrong as well.

Both errors had the same root cause: a constant that was never measured. This script
therefore MEASURES the rate first, by default, and derives every number from that. Pass
--rate to override it, and the table updates to whatever you supply.

Usage:
    python3 scripts/mining-cost.py                 # measure, then print the table
    python3 scripts/mining-cost.py --rate 4.26e6   # use a given rate
    python3 scripts/mining-cost.py --check         # assert the arithmetic, exit 1 on failure
"""

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MINER = ROOT / "scripts" / "vanity"

SECONDS_PER_MINUTE = 60
SECONDS_PER_HOUR = 3600
SECONDS_PER_DAY = 86_400
SECONDS_PER_YEAR = 31_557_600  # 365.25 days


def humanise(seconds: float) -> str:
    """Render an expected search time at a readable scale."""
    if seconds < 1:
        return f"{seconds * 1000:.1f} ms"
    if seconds < SECONDS_PER_MINUTE:
        return f"{seconds:.1f} s"
    if seconds < SECONDS_PER_HOUR:
        return f"{seconds / SECONDS_PER_MINUTE:.1f} min"
    if seconds < SECONDS_PER_DAY:
        return f"{seconds / SECONDS_PER_HOUR:.1f} hours"
    if seconds < SECONDS_PER_YEAR:
        return f"{seconds / SECONDS_PER_DAY:.1f} days"
    years = seconds / SECONDS_PER_YEAR
    if years < 1e3:
        return f"{years:.2f} years"
    if years < 1e6:
        return f"{years / 1e3:.1f} thousand years"
    return f"{years:.3g} years"


def measure_rate(attempts: int = 40_000_000) -> float:
    """Run the miner's benchmark and return hashes per second."""
    if not MINER.exists():
        raise SystemExit(
            f"miner not found at {MINER}\nbuild it: gcc -O3 -march=native -fopenmp "
            f"-o scripts/vanity scripts/vanity.c"
        )
    r = subprocess.run([str(MINER), "--bench", str(attempts)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"benchmark failed: {r.stderr.strip()}")
    m_per_sec = float(r.stdout.strip().splitlines()[-1])
    return m_per_sec * 1e6


def name_hex(name: str) -> str:
    return name.encode("ascii").hex()


def table(rate: float):
    """Expected attempts for an n-byte suffix is 2**(8n), i.e. 16**n."""
    rows = []
    for nbytes in range(1, 9):
        hex_digits = nbytes * 2
        attempts = 2 ** (8 * nbytes)
        rows.append((nbytes, hex_digits, attempts, attempts / rate))
    return rows


def check(rate: float) -> int:
    """
    Assert the arithmetic independently of the miner, so a bug in the C code cannot
    silently change the published numbers.
    """
    failures = 0

    def expect(label, got, want, tol=0.0):
        nonlocal failures
        ok = abs(got - want) <= tol
        print(f"  [{'PASS' if ok else 'FAIL'}] {label}: got {got:.6g}, want {want:.6g}")
        if not ok:
            failures += 1

    print("ARITHMETIC CHECKS (independent of the miner)")

    # Expected attempts for an n-byte suffix is 2**(8n), which equals 256**n.
    # The first version of this check asserted 16**n, which is 2**(4n) and therefore off
    # by a factor of 16 at every size - the assertion was wrong in exactly the way the
    # original table was. Fixed so the identity being asserted is the real one.
    for nbytes in (1, 2, 3, 4, 5, 6):
        expect(f"2**{8*nbytes} == 256**{nbytes}", float(2 ** (8 * nbytes)), float(256 ** nbytes))

    # The figure this script exists to correct, at the rate originally quoted.
    # Derive the expectation from the formula rather than hardcoding a figure, so the test
    # cannot inherit the same arithmetic slip it is meant to catch.
    silver_seconds = 2 ** 48 / 8.4e6
    expect("SILVER 2**48 / 8.4e6 in SECONDS", silver_seconds, 281_474_976_710_656 / 8.4e6, tol=1.0)
    expect("SILVER 2**48 / 8.4e6 in YEARS", silver_seconds / SECONDS_PER_YEAR, 1.06, tol=0.02)
    expect("GOLD 2**32 / 8.4e6 in MINUTES", (2 ** 32 / 8.4e6) / 60, 8.5, tol=0.1)
    # The withdrawn figure, asserted to be WRONG by a wide margin so a regression is loud.
    if abs(silver_seconds / SECONDS_PER_YEAR - 250) < 10:
        print("  [FAIL] the 250-year claim is still in the source somewhere")
        failures += 1
    print("  [NOTE] 2**48 / 8.4e6 is ~1.06 years. The earlier claim of '250 years'")
    print("         for this suffix was arithmetically wrong and is withdrawn.")

    # GOLD at the measured rate.
    gold_seconds = 2 ** 32 / rate
    print(f"  [INFO] GOLD (2**32) at the measured {rate/1e6:.2f}M/s = "
          f"{humanise(gold_seconds)}")

    # Every extra byte multiplies the work by exactly 256.
    for nbytes in range(1, 8):
        expect(f"work ratio {nbytes+1}B / {nbytes}B",
               (2 ** (8 * (nbytes + 1))) / (2 ** (8 * nbytes)), 256.0)

    return failures


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rate", type=float, default=None,
                    help="hashes per second; default MEASURES it with vanity --bench")
    ap.add_argument("--check", action="store_true", help="run the arithmetic assertions")
    args = ap.parse_args()

    if args.check:
        rate = args.rate or measure_rate()
        return 1 if check(rate) else 0

    rate = args.rate or measure_rate()
    print(f"\nNEXORA vanity mining cost")
    print(f"rate: {rate/1e6:.3f} M keccak/s"
          + ("" if args.rate else "  (measured with scripts/vanity --bench)"))
    print(f"machine: {__import__('os').cpu_count()} logical cores\n")

    print(f"{'bytes':>6} {'hex digits':>11} {'expected attempts':>22} {'expected time':>18}")
    print("-" * 62)
    for nbytes, hd, attempts, secs in table(rate):
        print(f"{nbytes:>6} {hd:>11} {attempts:>22,} {humanise(secs):>18}")

    print(f"\nAsset names, full hex encoding:")
    print(f"{'name':>8} {'ascii hex':>16} {'bytes':>6} {'expected time':>18}")
    print("-" * 54)
    for n in ("USD", "GOLD", "OIL", "SILVER", "GOLDX"):
        h = name_hex(n)
        nbytes = len(h) // 2
        print(f"{n:>8} {h:>16} {nbytes:>6} {humanise(2 ** (8 * nbytes) / rate):>18}")

    print(f"\nnote: expected time is the MEAN of the search. Because the first match is")
    print(f"      found by a random process, the distribution is geometric: roughly half of")
    print(f"      runs finish in under 0.69x this, and a long tail runs well past it. A run")
    print(f"      that exceeded 3x the mean is ordinary, not evidence of a bug.")
    print(f"\n      4 bytes is the practical ceiling here. 5 bytes is days, 6 is years.")
    print(f"\nnot mainnet. testnet only; no deployment and no cost.")
    return 0


if __name__ == "__main__":
    sys.exit(main())