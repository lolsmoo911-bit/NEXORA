#!/usr/bin/env python3
"""Windows-portable replacement for ci/phase2/genesis.sh (no jq/bash).

Reads chain/nexora-devnet.json + upstream local_node.sh mnemonics, then
mirrors genesis.sh step-for-step with Python JSON/regex patches. Deterministic:
genesis_time pinned, fixed node id/ip for the gentx memo. No key material is
stored in the repo; mnemonics come only from the pinned upstream checkout.
Outputs the generated home + params-summary.txt. Keys never print.
"""
import json, re, subprocess, sys, hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # source/
PARAMS = ROOT / "chain" / "nexora-devnet.json"
UPSTREAM = ROOT / "workbench" / "toolchain" / "evm-c3ae9067a7eadcdea55a5192226916deb44c71c4"
HOME = ROOT / "workbench" / "local-testnet" / "home"
EVMD = ROOT / "workbench" / "toolchain" / "bin" / "evmd.exe"
KEYRING = "test"
KEYALGO = "eth_secp256k1"
MONIKER = "nexora-devnet-node"

def log(m):
    print(f"[genesis-win] {m}", file=sys.stderr, flush=True)

def run(args, stdin=None):
    p = subprocess.run([str(EVMD)] + args, input=stdin, capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        log(f"FAILED: evmd {' '.join(args)} exit={p.returncode}")
        log("stdout: " + (p.stdout or "")[-2000:])
        log("stderr: " + (p.stderr or "")[-2000:])
        raise SystemExit(1)
    return p

def main():
    params = json.loads(PARAMS.read_text())
    c_chain = params["cosmos_chain_id"]
    e_chain = str(params["evm_chain_id"])
    denom = params["denom"]["base"]; disp = params["denom"]["display"]
    exp = int(params["denom"]["exponent"]); sym = params["denom"]["symbol"]
    dname = params["denom"]["name"]; ddesc = params["denom"]["description"]
    min_gas = params["fees"]["min_gas_price"]; gas_price = params["fees"]["gas_price"]
    max_gas = params["consensus"]["block_max_gas"]
    val_bal = params["accounts"]["validator_balance"]; dev_bal = params["accounts"]["dev_balance"]
    dev_names = params["accounts"]["names"]; val_name = params["accounts"]["validator"]
    gen_time = params["genesis_time"]
    log(f"cosmos={c_chain} evm={e_chain} denom={denom}({disp},{exp})")

    local_node = (UPSTREAM / "local_node.sh").read_text(errors="replace")
    m = re.search(r'^\s*VAL_MNEMONIC="([^"]+)"', local_node, re.M)
    if not m:
        log("could not read VAL_MNEMONIC from upstream"); sys.exit(1)
    val_mn = m.group(1)
    m2 = re.search(r'default_mnemonics=\((.*?)\)', local_node, re.S)
    dev_mns = re.findall(r'"([^"]+)"', m2.group(1)) if m2 else []
    if len(dev_mns) < len(dev_names):
        log(f"upstream provided {len(dev_mns)} dev mnemonics, need {len(dev_names)}"); sys.exit(1)

    # clean home
    import shutil
    if HOME.exists(): shutil.rmtree(HOME)
    HOME.mkdir(parents=True)
    run(["config", "set", "client", "chain-id", c_chain, "--home", str(HOME)])
    run(["config", "set", "client", "keyring-backend", KEYRING, "--home", str(HOME)])
    run(["keys", "add", val_name, "--recover", "--keyring-backend", KEYRING, "--algo", KEYALGO, "--home", str(HOME)], stdin=val_mn)
    for name, mn in zip(dev_names, dev_mns):
        run(["keys", "add", name, "--recover", "--keyring-backend", KEYRING, "--algo", KEYALGO, "--home", str(HOME)], stdin=mn)
    run(["init", MONIKER, "-o", "--chain-id", c_chain, "--home", str(HOME), "--recover"], stdin=val_mn)

    gen_path = HOME / "config" / "genesis.json"
    g = json.loads(gen_path.read_text())

    def fixdenoms(o):
        if isinstance(o, dict):
            if isinstance(o.get("denom"), str):
                o["denom"] = denom
            for k, v in o.items():
                o[k] = fixdenoms(v)
            return o
        elif isinstance(o, list):
            return [fixdenoms(x) for x in o]
        return o

    g["genesis_time"] = gen_time
    g["consensus"]["params"]["block"]["max_gas"] = max_gas
    g["app_state"]["staking"]["params"]["bond_denom"] = denom
    g["app_state"]["mint"]["params"]["mint_denom"] = denom
    g["app_state"]["evm"]["params"]["evm_denom"] = denom
    g["app_state"] = fixdenoms(g["app_state"])
    g["app_state"]["bank"]["denom_metadata"] = [{
        "description": ddesc,
        "denom_units": [
            {"denom": denom, "exponent": 0, "aliases": []},
            {"denom": disp, "exponent": exp, "aliases": []},
        ],
        "base": denom, "display": disp, "name": dname, "symbol": sym, "uri": "", "uri_hash": "",
    }]
    g["app_state"]["erc20"]["native_precompiles"] = ["0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"]
    g["app_state"]["erc20"]["token_pairs"] = [{
        "contract_owner": 1,
        "erc20_address": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        "denom": denom, "enabled": True,
    }]
    if isinstance(g["app_state"]["evm"]["params"].get("extended_denom_options"), dict):
        g["app_state"]["evm"]["params"]["extended_denom_options"]["extended_denom"] = denom
    gen_path.write_text(json.dumps(g, indent=2) + "\n")

    for name in dev_names:
        run(["genesis", "add-genesis-account", name, dev_bal, "--keyring-backend", KEYRING, "--home", str(HOME)])
    run(["genesis", "add-genesis-account", val_name, val_bal, "--keyring-backend", KEYRING, "--home", str(HOME)])
    run(["genesis", "gentx", val_name, "1000000000000000000000" + denom, "--gas-prices", gas_price,
         "--keyring-backend", KEYRING, "--chain-id", c_chain, "--home", str(HOME),
         "--node-id", "nexoradevvalidator", "--ip", "127.0.0.1", "--moniker", MONIKER])
    run(["genesis", "collect-gentxs", "--home", str(HOME)])
    # re-pin time after gentx round-trip
    g = json.loads(gen_path.read_text()); g["genesis_time"] = gen_time
    gen_path.write_text(json.dumps(g, indent=2) + "\n")

    def patch(path, subs):
        t = path.read_text(encoding="utf-8")
        for a, b in subs:
            t = re.sub(a, b, t, flags=re.M)
        path.write_text(t, encoding="utf-8")

    patch(HOME / "config" / "config.toml", [
        (r'timeout_propose = "3s"', 'timeout_propose = "2s"'),
        (r'timeout_propose_delta = "500ms"', 'timeout_propose_delta = "200ms"'),
        (r'timeout_prevote = "1s"', 'timeout_prevote = "500ms"'),
        (r'timeout_prevote_delta = "500ms"', 'timeout_prevote_delta = "200ms"'),
        (r'timeout_precommit = "1s"', 'timeout_precommit = "500ms"'),
        (r'timeout_precommit_delta = "500ms"', 'timeout_precommit_delta = "200ms"'),
        (r'timeout_commit = "5s"', 'timeout_commit = "1s"'),
        (r'timeout_broadcast_tx_commit = "10s"', 'timeout_broadcast_tx_commit = "5s"'),
        (r'type = "flood"', 'type = "app"'),
        (r'pprof_laddr = "localhost:6060"', 'pprof_laddr = "127.0.0.1:6060"'),
    ])
    patch(HOME / "config" / "app.toml", [
        (r'^evm-chain-id = .*', f"evm-chain-id = {e_chain}"),
        (r'^minimum-gas-prices = .*', f'minimum-gas-prices = "{min_gas}"'),
        (r'^enable = false', "enable = true"),
        (r'^enabled = false', "enabled = true"),
        # This host's DNS cannot resolve "localhost" (verified: pprof lookup
        # 1.1.1.1 fails). The canonical CI genesis binds localhost, which works
        # on Linux CI. Bind loopback by IP here so api/grpc start instead of
        # erroring and cancelling the JSON-RPC server.
        (r'address = "tcp://localhost:1317"', 'address = "tcp://127.0.0.1:1317"'),
        (r'address = "localhost:9090"', 'address = "127.0.0.1:9090"'),
    ])

    run(["genesis", "validate-genesis", "--home", str(HOME)])
    sha = hashlib.sha256(gen_path.read_bytes()).hexdigest()
    summary = {
        "cosmos_chain_id": c_chain, "evm_chain_id": int(e_chain), "evm_chain_id_hex": hex(int(e_chain)),
        "genesis_time": gen_time,
        "staking_bond_denom": g["app_state"]["staking"]["params"]["bond_denom"],
        "mint_denom": g["app_state"]["mint"]["params"]["mint_denom"],
        "evm_denom": g["app_state"]["evm"]["params"]["evm_denom"],
        "bank_base": g["app_state"]["bank"]["denom_metadata"][0]["base"],
        "bank_display": g["app_state"]["bank"]["denom_metadata"][0]["display"],
        "display_exponent": [u for u in g["app_state"]["bank"]["denom_metadata"][0]["denom_units"] if u["denom"] == disp][0]["exponent"],
        "symbol": g["app_state"]["bank"]["denom_metadata"][0]["symbol"],
        "block_max_gas": g["consensus"]["params"]["block"]["max_gas"],
        "genesis_sha256": sha,
    }
    (HOME / "params-summary.txt").write_text(json.dumps(summary, indent=2))
    stale = re.findall(r'"(stake|atest|aphoton|uatom|aatom|atom)"', gen_path.read_text())
    if stale:
        log(f"stale denoms present: {sorted(set(stale))}"); sys.exit(1)
    log("DONE deterministic genesis ready at " + str(HOME))
    log("genesis_sha256=" + sha)

if __name__ == "__main__":
    main()
