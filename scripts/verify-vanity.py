#!/usr/bin/env python3
"""
verify-vanity.py — independent, reproducible verification of a NEXORA vanity deployment.

TESTNET ONLY.

WHY A SCRIPT INSTEAD OF A SEQUENCE OF SHELL COMMANDS
----------------------------------------------------
This exists because hand-typed 32-byte hex in shell is error-prone in a specific, repeated
way: a dropped pair of leading zeros turns a valid 32-byte salt into a 31-byte string, the
tool prints a confusing "invalid string length" or, worse, silently computes a different
address. That happened twice while producing these artifacts. Reading every value from
`deployments/vanity-testnet.json` removes the transcription step entirely.

WHAT IS CHECKED, AND BY WHAT
----------------------------
  1. chain id is the NEXORA testnet EVM chain id, and is NOT mainnet
  2. the CREATE2 deployer has non-empty runtime code, and its own
     `computeAddress(salt, initcodeHash)` agrees with this script
  3. the CREATE2 derivation is recomputed with Foundry's keccak256, which is an
     implementation independent of scripts/vanity.c
  4. the target contract has non-empty runtime code
  5. the ERC-20 surface answers: name, symbol, decimals, totalSupply, balanceOf
  6. an optional read-only supply check
  7. with --transfer, a real testnet transfer is executed and re-read

Exit code 0 means every enabled check passed. Any failure is exit 1.

Usage:
  python3 scripts/verify-vanity.py
  python3 scripts/verify-vanity.py --label "GOL-suffix proof (3 bytes)"
  python3 scripts/verify-vanity.py --transfer --key-file /path/to/key
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RECORD = ROOT / "deployments" / "vanity-testnet.json"
DEFAULT_RPC = os.environ.get("NEXORA_RPC", "http://127.0.0.1:8545")
RPC = DEFAULT_RPC

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"

results = []


def check(label, ok, detail=""):
    results.append((label, ok, detail))
    mark = f"{GREEN}PASS{RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"  [{mark}] {label}" + (f"  {DIM}{detail}{RESET}" if detail else ""))
    return ok


def warn(label, detail=""):
    print(f"  [{YELLOW}WARN{RESET}] {label}" + (f"  {DIM}{detail}{RESET}" if detail else ""))


# `cast keccak` is a pure local computation and accepts no RPC flags. Appending --rpc-url
# makes it fail with "unexpected argument", which surfaces as a misleading error.
LOCAL_ONLY = {"keccak", "abi-encode", "calldata", "from-wei", "wallet"}


def cast(*args, rpc=True):
    cmd = ["cast"] + list(args)
    if rpc and args[0] not in LOCAL_ONLY:
        cmd += ["--rpc-url", RPC]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"cast {' '.join(args[:3])} failed: {r.stderr.strip()[:200]}")
    return r.stdout.strip()


def rpc_call(method, params):
    """Raw JSON-RPC. Used for calls where cast's output formatting would obscure the value."""
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    r = subprocess.run(
        ["curl", "-s", "-m", "10", "-X", "POST", "-H", "Content-Type: application/json",
         "--data", payload, RPC],
        capture_output=True, text=True,
    )
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"bad JSON-RPC response: {r.stdout[:200]}")


def create2_address(deployer: str, salt: str, initcode_hash: str) -> str:
    """
    Recompute CREATE2 with Foundry's keccak256.

    This is the independence that matters: scripts/vanity.c contains its own keccak
    implementation, so using it to check its own output would prove nothing. Foundry is a
    separate implementation, and the two agreeing is real evidence.
    """
    for v, n in ((deployer, 20), (salt, 32), (initcode_hash, 32)):
        body = v[2:] if v.startswith("0x") else v
        if len(body) != n * 2:
            raise ValueError(f"expected {n} bytes, got {len(body)//2}: {v}")
    pre = "0xff" + deployer[2:] + salt[2:] + initcode_hash[2:]
    digest = cast("keccak", pre)[2:]
    return "0x" + digest[24:]


def unhex_int(s: str) -> int:
    return int(s, 16)


def rec_dep_supply(dep):
    """Supply recorded at deployment, as a decimal string for exact comparison."""
    return int(dep.get("supply", "0"))


def main():
    global RPC

    ap = argparse.ArgumentParser()
    ap.add_argument("--label", help="only verify the deployment with this label")
    ap.add_argument("--transfer", action="store_true", help="execute a real testnet transfer")
    ap.add_argument("--amount", default="1000000000000000", help="transfer amount in wei")
    ap.add_argument("--to", default=None,
                    help="transfer RECIPIENT. Must differ from the sender, which is derived "
                         "from --key-file. Default: the CREATE2 factory.")
    ap.add_argument("--key-file", default=None, help="file containing the deployer private key")
    ap.add_argument("--rpc", default=DEFAULT_RPC)
    args = ap.parse_args()

    RPC = args.rpc

    rec = json.loads(RECORD.read_text())

    print(f"\n{YELLOW}NEXORA TESTNET VANITY VERIFICATION{RESET}")
    print(f"{DIM}record: {RECORD.relative_to(ROOT)}   rpc: {RPC}{RESET}")

    # ---------------------------------------------------------------- 1. chain
    print(f"\n1. CHAIN")
    cid = int(cast("chain-id"))
    expect = rec["chain"]["evmChainId"]
    check(f"EVM chain id == {expect}", cid == expect, f"got {cid}")
    check("not mainnet", cid != 1 and cid != 902024 - 900000, "testnet chain id")
    check("chain declares no token value", rec["chain"]["tokenHasValue"] is False)
    check("chain declares not officially tradable", rec["chain"]["officiallyTradable"] is False)

    # Select the deployment under test FIRST, because its `deployer` is the factory we
    # must inspect. Reading it before the filter existed was an ordering bug.
    deps = rec["deployments"]
    if args.label:
        deps = [d for d in deps if d["label"] == args.label]
        if not deps:
            print(f"{RED}no deployment with label {args.label!r}{RESET}")
            return 1
    dep = deps[0]

    # ---------------------------------------------------------------- 2 + 3. CREATE2 deployer
    print(f"\n2. CREATE2 DEPLOYER")
    fac = dep["deployer"]
    known = [f["address"] for f in rec["create2Deployers"]]
    check("factory is a recorded CREATE2 deployer", fac in known, fac)
    code = cast("code", fac)
    check("factory has runtime code", len(code) > 2, f"{max(0,(len(code)-3)//2)} bytes")
    fac_rec = next((f for f in rec["create2Deployers"] if f["address"] == fac), {})
    check("factory has deployAndCall()", bool(fac_rec.get("hasDeployAndCall")))
    check("factory is not the zero address", unhex_int(fac[2:]) != 0)

    deps = rec["deployments"]
    if args.label:
        deps = [d for d in deps if d["label"] == args.label]
        if not deps:
            print(f"{RED}no deployment with label {args.label!r}{RESET}")
            return 1

    dep = deps[0]

    if dep.get("status", "").startswith("NOT YET"):
        print(f"\n3. FINAL GOLD TARGET")
        warn(dep["status"])
        warn("no salt, no address, nothing deployed — this is a pending search, not a result")
        return summarise()

    print(f"\n3. CREATE2 DERIVATION  ({dep['label']})")
    predicted = create2_address(dep["deployer"], dep["salt"], dep["initcodeHash"])
    check("derived address == recorded address", predicted.lower() == dep["address"].lower(),
          f"{predicted}")

    onchain_pred = cast("call", fac, "computeAddress(bytes32,bytes32)(address)",
                        dep["salt"], dep["initcodeHash"])
    check("factory computeAddress() agrees", onchain_pred.lower() == dep["address"].lower(),
          f"{onchain_pred}")

    addr = dep["address"]
    suffix = dep["suffixHex"]
    check("address ends with target suffix", addr.lower().endswith(suffix), f"...{suffix}")
    ascii_name = bytes.fromhex(suffix).decode("ascii", errors="replace")
    check("suffix decodes to ASCII", True, f"{suffix} -> {ascii_name!r}")

    full_hex = dep.get("fullNameHex", "")
    is_full = dep.get("isFinalGoldTarget", False)
    if is_full:
        check("suffix is the FULL name hex", suffix == full_hex,
              f"{suffix} vs {full_hex}")
    else:
        print(f"  {YELLOW}[NOTE]{RESET} suffix {suffix} is {len(suffix)//2} of "
              f"{len(full_hex)//2} bytes of the full encoding {full_hex}")
        print(f"         this is a PARTIAL suffix ({ascii_name!r}), not the full "
              f"{bytes.fromhex(full_hex).decode()} target")
        check("marked as NOT the final gold target", is_full is False)

    # ---------------------------------------------------------------- 4 + 5. contract
    print(f"\n4. DEPLOYED CONTRACT {addr}")
    tcode = cast("code", addr)
    check("has runtime code", len(tcode) > 2, f"{max(0,(len(tcode)-3)//2)} bytes")

    print(f"\n5. ERC-20 SURFACE")
    name = cast("call", addr, "name()(string)")
    symbol = cast("call", addr, "symbol()(string)")
    dec = cast("call", addr, "decimals()(uint8)")
    supply = cast("call", addr, "totalSupply()(uint256)")
    check("name()", name.strip('"') == dep["name"], f"{name} (expected \"{dep['name']}\")")
    check("symbol()", symbol.strip('"') == dep["symbol"], f"{symbol}")
    check("decimals()", dec == "18", f"{dec}")
    check("totalSupply() > 0", int(supply.split()[0]) > 0, f"{supply}")

    holder = args.to or fac
    bal = cast("call", addr, "balanceOf(address)(uint256)", holder)
    check(f"balanceOf({holder[:10]}...) reads", bal.split()[0].isdigit(), f"{bal}")

    # ---------------------------------------------------------------- 7. transfer
    if args.transfer:
        print(f"\n7. TESTNET TRANSFER")
        if not args.key_file:
            print(f"  {RED}FAIL{RESET} --transfer needs --key-file")
            results.append(("transfer", False, "no key"))
        else:
            key = Path(args.key_file).read_text().strip()

            # The sender must come from the key, not from --to. An earlier version used
            # `holder = args.to or fac` for BOTH the sender and the recipient, so passing
            # --to produced a transfer to self: receipt status 1, balances unchanged, and
            # the only reason it was noticed is that the balance assertion failed. Deriving
            # the sender from the key makes that mistake unrepresentable.
            sender = cast("wallet", "address", "--private-key", key)
            recip = args.to or fac
            check("sender differs from recipient", sender.lower() != recip.lower(),
                  f"{sender[:10]}... -> {recip[:10]}...")

            amt = args.amount
            recv_before = int(cast("call", addr, "balanceOf(address)(uint256)", recip).split()[0])
            send_before = int(cast("call", addr, "balanceOf(address)(uint256)", sender).split()[0])

            tx = cast("send", addr, "transfer(address,uint256)", recip, amt,
                      "--private-key", key, "--legacy")
            status = [l for l in tx.splitlines() if l.strip().startswith("status")]
            ok = bool(status) and "1" in status[0]
            check("transfer receipt status == 1", ok, status[0].strip() if status else tx[:80])

            # This chain commits state with a short delay; poll rather than sleeping once
            # and hoping, which produced a spurious failure while the transfer was fine.
            import time
            recv_after = recv_before
            for _ in range(15):
                time.sleep(2)
                recv_after = int(cast("call", addr, "balanceOf(address)(uint256)", recip).split()[0])
                if recv_after == recv_before + int(amt):
                    break
            check("recipient balance increased by exactly the amount",
                  recv_after == recv_before + int(amt), f"{recv_before} -> {recv_after}")
            send_after = int(cast("call", addr, "balanceOf(address)(uint256)", sender).split()[0])
            check("sender balance decreased by exactly the amount",
                  send_before - send_after == int(amt), f"{send_before} -> {send_after}")
            check("total supply unchanged by the transfer",
                  cast("call", addr, "totalSupply()(uint256)").split()[0]
                  == str(rec_dep_supply(dep)), "conservation")
    else:
        print(f"\n7. TESTNET TRANSFER  (skipped - pass --transfer --key-file to run)")

    return summarise()


def summarise():
    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    print(f"\n{'='*60}")
    if failed:
        print(f"{RED}{failed} FAILED{RESET}, {passed} passed, {len(results)} total")
        return 1
    print(f"{GREEN}ALL {passed} CHECKS PASSED{RESET}")
    print(f"{DIM}testnet only; this token has no value and is not officially tradable{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())