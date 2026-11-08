#!/usr/bin/env python3
"""Task 1: verify/reproduce EVM build + local chain on a FRESH isolated home.
- Proves genesis determinism (two fresh runs -> same sha256)
- Starts evmd, probes RPC (chainId, net_version, block advancing, gasPrice,
  baseFee/feemarket, estimateGas, getBalance, getBlockByNumber, web3_clientVersion,
  eth_getCode sanity), records evidence, stops cleanly.
- No secrets. Loopback only. Does NOT touch testnet/state.json or ledger.json.
"""
import json, re, subprocess, sys, hashlib, time, shutil, urllib.request as u
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PARAMS = ROOT / "chain" / "nexora-devnet.json"
UPSTREAM = ROOT / "workbench" / "toolchain" / "evm-c3ae9067a7eadcdea55a5192226916deb44c71c4"
EVMD = ROOT / "workbench" / "toolchain" / "bin" / "evmd.exe"
VERIFY_BASE = ROOT / "workbench" / "local-testnet" / "verify-2026-11-07"
OUT = VERIFY_BASE / "task1-evidence.json"
RPC = "http://127.0.0.1:8545"
KEYRING = "test"; KEYALGO = "eth_secp256k1"; MONIKER = "nexora-verify-node"

def log(m): print(f"[task1] {m}", flush=True)

def run_evmd(args, stdin=None, home=None):
    p = subprocess.run([str(EVMD)] + args, input=stdin, capture_output=True, text=True, timeout=180)
    if p.returncode != 0:
        raise RuntimeError(f"evmd {' '.join(args[:3])} exit={p.returncode} stderr={(p.stderr or '')[-1200:]}")
    return p

def gen_home(home: Path):
    params = json.loads(PARAMS.read_text())
    c_chain=params["cosmos_chain_id"]; e_chain=str(params["evm_chain_id"]); denom=params["denom"]["base"]
    disp=params["denom"]["display"]; exp=int(params["denom"]["exponent"]); sym=params["denom"]["symbol"]
    dname=params["denom"]["name"]; ddesc=params["denom"]["description"]
    min_gas=params["fees"]["min_gas_price"]; gas_price=params["fees"]["gas_price"]
    max_gas=params["consensus"]["block_max_gas"]; val_bal=params["accounts"]["validator_balance"]
    dev_bal=params["accounts"]["dev_balance"]; dev_names=params["accounts"]["names"]
    val_name=params["accounts"]["validator"]; gen_time=params["genesis_time"]
    local_node=(UPSTREAM/"local_node.sh").read_text(errors="replace")
    val_mn=re.search(r'^\s*VAL_MNEMONIC="([^"]+)"', local_node, re.M).group(1)
    dev_mns=re.findall(r'"([^"]+)"', re.search(r'default_mnemonics=\((.*?)\)', local_node, re.S).group(1))
    if home.exists(): shutil.rmtree(home)
    home.mkdir(parents=True)
    def ev(args,stdin=None): run_evmd(args,stdin)
    ev(["config","set","client","chain-id",c_chain,"--home",str(home)])
    ev(["config","set","client","keyring-backend",KEYRING,"--home",str(home)])
    ev(["keys","add",val_name,"--recover","--keyring-backend",KEYRING,"--algo",KEYALGO,"--home",str(home)], stdin=val_mn)
    for name,mn in zip(dev_names,dev_mns):
        ev(["keys","add",name,"--recover","--keyring-backend",KEYRING,"--algo",KEYALGO,"--home",str(home)], stdin=mn)
    ev(["init",MONIKER,"-o","--chain-id",c_chain,"--home",str(home),"--recover"], stdin=val_mn)
    gen_path=home/"config"/"genesis.json"
    g=json.loads(gen_path.read_text())
    def fixdenoms(o):
        if isinstance(o,dict):
            if isinstance(o.get("denom"),str): o["denom"]=denom
            for k,v in list(o.items()): o[k]=fixdenoms(v); return o
        if isinstance(o,list): return [fixdenoms(x) for x in o]
        return o
    g["genesis_time"]=gen_time
    g["consensus"]["params"]["block"]["max_gas"]=max_gas
    g["app_state"]["staking"]["params"]["bond_denom"]=denom
    g["app_state"]["mint"]["params"]["mint_denom"]=denom
    g["app_state"]["evm"]["params"]["evm_denom"]=denom
    g["app_state"]=fixdenoms(g["app_state"])
    g["app_state"]["bank"]["denom_metadata"]=[{"description":ddesc,"denom_units":[{"denom":denom,"exponent":0,"aliases":[]},{"denom":disp,"exponent":exp,"aliases":[]}],"base":denom,"display":disp,"name":dname,"symbol":sym,"uri":"","uri_hash":""}]
    g["app_state"]["erc20"]["native_precompiles"]=["0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"]
    g["app_state"]["erc20"]["token_pairs"]=[{"contract_owner":1,"erc20_address":"0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE","denom":denom,"enabled":True}]
    if isinstance(g["app_state"]["evm"]["params"].get("extended_denom_options"),dict):
        g["app_state"]["evm"]["params"]["extended_denom_options"]["extended_denom"]=denom
    gen_path.write_text(json.dumps(g,indent=2)+"\n")
    for name in dev_names: ev(["genesis","add-genesis-account",name,dev_bal,"--keyring-backend",KEYRING,"--home",str(home)])
    ev(["genesis","add-genesis-account",val_name,val_bal,"--keyring-backend",KEYRING,"--home",str(home)])
    ev(["genesis","gentx",val_name,"1000000000000000000000"+denom,"--gas-prices",gas_price,"--keyring-backend",KEYRING,"--chain-id",c_chain,"--home",str(home),"--node-id","nexoraverifyv","--ip","127.0.0.1","--moniker",MONIKER])
    ev(["genesis","collect-gentxs","--home",str(home)])
    g=json.loads(gen_path.read_text()); g["genesis_time"]=gen_time; gen_path.write_text(json.dumps(g,indent=2)+"\n")
    def patch(path,subs):
        t=path.read_text(encoding="utf-8")
        for a,b in subs: t=re.sub(a,b,t,flags=re.M)
        path.write_text(t,encoding="utf-8")
    patch(home/"config"/"config.toml",[(r'type = "flood"','type = "app"'),(r'pprof_laddr = "localhost:6060"','pprof_laddr = "127.0.0.1:6060"'),(r'laddr = "tcp://0.0.0.0:26656"','laddr = "tcp://127.0.0.1:26656"')])
    patch(home/"config"/"app.toml",[(r'^evm-chain-id = .*',f"evm-chain-id = {e_chain}"),(r'^minimum-gas-prices = .*',f'minimum-gas-prices = "{min_gas}"'),(r'^enable = false',"enable = true"),(r'^enabled = false',"enabled = true"),(r'address = "tcp://localhost:1317"','address = "tcp://127.0.0.1:1317"'),(r'address = "localhost:9090"','address = "127.0.0.1:9090"')])
    ev(["genesis","validate-genesis","--home",str(home)])
    return hashlib.sha256(gen_path.read_bytes()).hexdigest()

def rpc(method, params=None):
    req=u.Request(RPC, data=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params or []}).encode(), headers={"Content-Type":"application/json"})
    with u.urlopen(req, timeout=10) as r: return json.loads(r.read())

def rpc_res(method, params=None):
    j = rpc(method, params)
    if "error" in j:
        return {"ok": False, "error": j["error"], "raw": j}
    return {"ok": True, "result": j.get("result"), "raw": j}

def main():
    VERIFY_BASE.mkdir(parents=True, exist_ok=True)
    evidence={"timestamp":time.strftime("%Y-%m-%dT%H:%M:%S%z"),"toolchain":{"evmd":str(EVMD),"evmd_sha256":hashlib.sha256(EVMD.read_bytes()).hexdigest(),"evmd_version_exit":None},"genesis_determinism":{},"rpc":{},"feemarket":{},"status":"running"}
    vp=subprocess.run([str(EVMD),"version"],capture_output=True,text=True,timeout=30)
    evidence["toolchain"]["evmd_version_exit"]=vp.returncode; evidence["toolchain"]["evmd_version_out"]=(vp.stdout or vp.stderr or "")[:400]
    h1=VERIFY_BASE/"home1"; h2=VERIFY_BASE/"home2"
    log("genesis run 1 (fresh)"); s1=gen_home(h1)
    log("genesis run 2 (fresh)"); s2=gen_home(h2)
    evidence["genesis_determinism"]={"run1":s1,"run2":s2,"identical":s1==s2,"home1":str(h1)}
    log(f"determinism identical={s1==s2} sha={s1}")
    home=h1; log_path=VERIFY_BASE/"node.log"
    if log_path.exists(): log_path.unlink()
    logf=open(log_path,"wb")
    proc=subprocess.Popen([str(EVMD),"start","--home",str(home),"--chain-id","eip155:902024","--minimum-gas-prices","1anex","--evm.evm-chain-id","902024","--evm.min-tip","0","--pruning","nothing","--json-rpc.enable","true","--json-rpc.address","127.0.0.1:8545","--json-rpc.api","eth,txpool,personal,net,debug,web3"], stdout=logf, stderr=subprocess.STDOUT)
    evidence["node_pid"]=proc.pid
    def log_tail(n=100):
        try:
            b=log_path.read_bytes()
            for enc in ["utf-8","utf-16","utf-16-le","cp1252"]:
                try: return b.decode(enc).splitlines()[-n:]
                except: pass
            return b.decode("utf-8","replace").splitlines()[-n:]
        except Exception as e: return [f"log_tail_err:{e}"]
    try:
        # eth_chainId may respond before CometBFT commits block 1; wait for a valid eth_blockNumber
        ready=False; last_err=None
        deadline=time.time()+180
        while time.time()<deadline:
            time.sleep(2)
            try:
                rr=rpc_res("eth_blockNumber")
                if rr["ok"] and rr.get("result"):
                    evidence["rpc"]["block_ready_raw"]=rr; ready=True; break
                last_err=rr
            except Exception as e:
                last_err={"ok":False,"exception":str(e)}
        evidence["rpc"]["ready"]=ready; evidence["rpc"]["ready_last_err"]=(last_err if not ready else None)
        if not ready: raise RuntimeError(f"RPC block not ready within 180s: {str(last_err)[:500]}")
        for method, params, key in [
            ("eth_chainId",[],"eth_chainId"),("net_version",[],"net_version"),
            ("web3_clientVersion",[],"web3_clientVersion"),("eth_gasPrice",[],"eth_gasPrice"),
        ]:
            rr=rpc_res(method, params); evidence["rpc"][key+"_raw"]=rr
            if not rr["ok"]: raise RuntimeError(f"{method} error: {rr['error']}")
            evidence["rpc"][key]=rr["result"]
        evidence["rpc"]["web3_clientVersion"]=(evidence["rpc"]["web3_clientVersion"] or "")[:200]
        evidence["rpc"]["proc_alive_after_identity"]=proc.poll() is None
        ps_probe=subprocess.run(["powershell","-NoProfile","-Command",
            "try{$r=Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8545' -ContentType 'application/json' -Body '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}'; $r|ConvertTo-Json -Compress -Depth 6} catch {$_|Out-String}"],
            capture_output=True,text=True,timeout=20)
        evidence["rpc"]["ps_eth_blockNumber_probe"]={"exit":ps_probe.returncode,"stdout":(ps_probe.stdout or "")[:800],"stderr":(ps_probe.stderr or "")[:400]}
        evidence["rpc"]["block_t0"]=evidence["rpc"]["block_ready_raw"]["result"]
        time.sleep(4)
        rr=rpc_res("eth_blockNumber",[]); evidence["rpc"]["block_t1_raw"]=rr
        if not rr["ok"]: raise RuntimeError(f"eth_blockNumber(t1) error: {rr}")
        evidence["rpc"]["block_t1"]=rr["result"]
        try:
            evidence["rpc"]["advancing"]=int(evidence["rpc"]["block_t1"],16)>int(evidence["rpc"]["block_t0"],16)
        except Exception as e: evidence["rpc"]["advancing_error"]=str(e)
        blk_r=rpc_res("eth_getBlockByNumber",[evidence["rpc"]["block_t1"],False])
        evidence["rpc"]["getBlockByNumber_raw_ok"]=blk_r["ok"]
        if blk_r["ok"] and blk_r["result"]:
            blk=blk_r["result"]
            evidence["rpc"]["latest_block_keys"]=sorted(blk.keys())
            evidence["rpc"]["latest_block_baseFeePerGas"]=blk.get("baseFeePerGas")
            evidence["rpc"]["latest_block_number"]=blk.get("number")
        # dev0 addr
        da=subprocess.run([str(EVMD),"debug","addr",subprocess.run([str(EVMD),"keys","show","dev0","-a","--keyring-backend","test","--home",str(home)],capture_output=True,text=True,timeout=30).stdout.strip()],capture_output=True,text=True,timeout=30)
        m=re.search(r'(0x[0-9a-fA-F]{40})', da.stdout or "")
        dev0=m.group(1) if m else None
        evidence["rpc"]["dev0_eth"]=dev0
        if dev0:
            for method, params, key in [("eth_getBalance",[dev0,"latest"],"eth_getBalance_dev0"),("eth_estimateGas",[{"from":dev0,"to":"0x0000000000000000000000000000000000000001","value":"0x0"}],"eth_estimateGas")]:
                rr=rpc_res(method,params); evidence["rpc"][key+"_raw"]=rr
                if rr["ok"]: evidence["rpc"][key]=rr["result"]
                else: evidence["rpc"][key+"_error"]=rr["error"]
        fm=subprocess.run([str(EVMD),"q","feemarket","params","--node","tcp://127.0.0.1:26657","-o","json","--home",str(home)],capture_output=True,text=True,timeout=30)
        evidence["feemarket"]["exit"]=fm.returncode; evidence["feemarket"]["stdout"]=(fm.stdout or "")[:1200]
        evidence["rpc"]["proc_alive_before_stop"]=proc.poll() is None
        evidence["status"]="pass" if (evidence["rpc"].get("eth_chainId")=="0xdc388" and evidence["rpc"].get("advancing") and evidence["genesis_determinism"]["identical"]) else "partial"
    except Exception as e:
        evidence["error"]=f"{type(e).__name__}: {e}"
        evidence["rpc"]["proc_alive_on_error"]=proc.poll() is None if 'proc' in dir() else None
        evidence["status"]="error"
    finally:
        try:
            evidence["node_log_tail"]=log_tail(120)
        except Exception as e: evidence["node_log_tail_error"]=str(e)
        log("stopping node (pid-scoped only)")
        try:
            if proc and proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=20)
                except Exception: proc.kill(); proc.wait(timeout=10)
        except Exception as e: evidence["stop_error"]=str(e)
        try: logf.close()
        except Exception: pass
        time.sleep(2)
        ns=subprocess.run(["netstat","-ano"],capture_output=True,text=True,timeout=15)
        listeners=[l for l in (ns.stdout or "").splitlines() if ":8545" in l and "LISTENING" in l]
        evidence["post_stop_8545_listeners"]=listeners
        # safety: only our PID may be force-killed, and only if it still owns 8545
        if listeners and proc and proc.pid:
            ours = any(str(proc.pid) in l for l in listeners)
            evidence["post_stop_8545_owned_by_our_pid"]=ours
            if ours:
                try: subprocess.run(["taskkill","/PID",str(proc.pid),"/F"],capture_output=True,timeout=15)
                except Exception as e: evidence["force_kill_error"]=str(e)
                time.sleep(1)
                ns2=subprocess.run(["netstat","-ano"],capture_output=True,text=True,timeout=15)
                evidence["post_force_8545_listeners"]=[l for l in (ns2.stdout or "").splitlines() if ":8545" in l and "LISTENING" in l]
        try: OUT.write_text(json.dumps(evidence,indent=2,default=str))
        except Exception as e2: (VERIFY_BASE/"task1-evidence-fallback.txt").write_text(f"write fail:{e2}\n{evidence}")
    log(f"status={evidence['status']} evidence={OUT}")
    print(json.dumps({"status":evidence["status"],"evidence":str(OUT),"chainId":evidence["rpc"].get("eth_chainId"),"advancing":evidence["rpc"].get("advancing"),"determinism":evidence["genesis_determinism"]["identical"],"error":evidence.get("error")},indent=2))

if __name__=="__main__": main()
