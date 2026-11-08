#!/usr/bin/env python3
"""Task 3 (authorized): broadcast AidRegistry + AidFactory to a FRESH isolated loopback
testnet at 127.0.0.1:8545, chain 902024 (0xdc388), using ONLY the safe Foundry
DeployAid.s.sol flow with DEPLOYER_PRIVATE_KEY via vm.envUint. --broadcast approved
ONLY for this exact disposable local chain.

Safety: separate fresh home under workbench/aid-deploy (never touches existing
workbench/local-testnet/home). Verifies loopback+chainId twice before broadcast.
Key loaded into process env for forge only, never printed/written/CLI-arg/logged,
cleared in finally. PID-scoped cleanup only. Aborts on any ambiguity.
"""
import json, re, subprocess, sys, hashlib, time, shutil, urllib.request as u, os, glob
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WB = ROOT / "workbench"
AID = WB / "aid-deploy"
PARAMS = ROOT / "chain" / "nexora-devnet.json"
UPSTREAM = WB / "toolchain" / "evm-c3ae9067a7eadcdea55a5192226916deb44c71c4"
EVMD = WB / "toolchain" / "bin" / "evmd.exe"
FORGE = WB / "toolchain" / "foundry" / "bin-content" / "forge.exe"
CAST = WB / "toolchain" / "foundry" / "bin-content" / "cast.exe"
FRESH_HOME = AID / "fresh-home-2026-11-07"
RPC = "http://127.0.0.1:8545"
EVIDENCE = AID / "observations-2026-11-07-broadcast.json"
LOG = AID / "broadcast-aid-node.log"
KEYRING="test"; KEYALGO="eth_secp256k1"; MONIKER="aid-deploy-fresh"

def log(m): print(f"[aid-broadcast] {m}", flush=True)

def die(msg, evidence):
    evidence["status"]="ABORTED"; evidence["abort_reason"]=msg
    try: EVIDENCE.write_text(json.dumps(evidence,indent=2,default=str))
    except: pass
    log("ABORT: "+msg); sys.exit(2)

def run_evmd(args, stdin=None):
    p = subprocess.run([str(EVMD)]+args, input=stdin, capture_output=True, text=True, timeout=180)
    if p.returncode != 0:
        raise RuntimeError(f"evmd {' '.join(args[:3])} exit={p.returncode} stderr={(p.stderr or '')[-800:]}")
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
    for name,mn in zip(dev_names,dev_mns): ev(["keys","add",name,"--recover","--keyring-backend",KEYRING,"--algo",KEYALGO,"--home",str(home)], stdin=mn)
    ev(["init",MONIKER,"-o","--chain-id",c_chain,"--home",str(home),"--recover"], stdin=val_mn)
    gen_path=home/"config"/"genesis.json"; g=json.loads(gen_path.read_text())
    def fix(o):
        if isinstance(o,dict):
            if isinstance(o.get("denom"),str): o["denom"]=denom
            for k,v in list(o.items()): o[k]=fix(v); return o
        if isinstance(o,list): return [fix(x) for x in o]
        return o
    g["genesis_time"]=gen_time; g["consensus"]["params"]["block"]["max_gas"]=max_gas
    g["app_state"]["staking"]["params"]["bond_denom"]=denom; g["app_state"]["mint"]["params"]["mint_denom"]=denom
    g["app_state"]["evm"]["params"]["evm_denom"]=denom; g["app_state"]=fix(g["app_state"])
    g["app_state"]["bank"]["denom_metadata"]=[{"description":ddesc,"denom_units":[{"denom":denom,"exponent":0,"aliases":[]},{"denom":disp,"exponent":exp,"aliases":[]}],"base":denom,"display":disp,"name":dname,"symbol":sym,"uri":"","uri_hash":""}]
    g["app_state"]["erc20"]["native_precompiles"]=["0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"]
    g["app_state"]["erc20"]["token_pairs"]=[{"contract_owner":1,"erc20_address":"0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE","denom":denom,"enabled":True}]
    if isinstance(g["app_state"]["evm"]["params"].get("extended_denom_options"),dict): g["app_state"]["evm"]["params"]["extended_denom_options"]["extended_denom"]=denom
    gen_path.write_text(json.dumps(g,indent=2)+"\n")
    for name in dev_names: ev(["genesis","add-genesis-account",name,dev_bal,"--keyring-backend",KEYRING,"--home",str(home)])
    ev(["genesis","add-genesis-account",val_name,val_bal,"--keyring-backend",KEYRING,"--home",str(home)])
    ev(["genesis","gentx",val_name,"1000000000000000000000"+denom,"--gas-prices",gas_price,"--keyring-backend",KEYRING,"--chain-id",c_chain,"--home",str(home),"--node-id","aidfreshval","--ip","127.0.0.1","--moniker",MONIKER])
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
    with u.urlopen(req, timeout=15) as r: return json.loads(r.read())
def rpc_res(method, params=None):
    j=rpc(method,params); return {"ok":"error" not in j, "result":j.get("result"), "error":j.get("error"), "raw":j}

def cast_call(to, sig, *args):
    p=subprocess.run([str(CAST),"call",to,sig,*args,"--rpc-url",RPC],capture_output=True,text=True,timeout=30,cwd=str(AID))
    return {"exit":p.returncode,"stdout":(p.stdout or "").strip(),"stderr":(p.stderr or "").strip()[:400]}

def main():
    evidence={"timestamp":time.strftime("%Y-%m-%dT%H:%M:%S%z"),"scope":"workbench/aid-deploy broadcast to fresh isolated loopback 127.0.0.1:8545 chain 902024","fresh_home":str(FRESH_HOME),"rpc":RPC,"expected_chain_id":"0xdc388","status":"running","safety":{"broadcast_approved":"only this loopback disposable chain","key_handling":"env DEPLOYER_PRIVATE_KEY for forge process only; never printed/written/CLI/logged; cleared in finally","script":"script/DeployAid.s.sol (vm.envUint)"}}
    # safety: never touch existing local-testnet/home
    existing = WB/"local-testnet"/"home"
    if not FRESH_HOME.resolve().is_relative_to(AID.resolve()): die("fresh home not under aid-deploy", evidence)
    if FRESH_HOME.resolve() == existing.resolve(): die("refusing to use existing local-testnet/home", evidence)

    log("generating fresh genesis"); evidence["genesis_sha256"]=gen_home(FRESH_HOME)
    if LOG.exists(): LOG.unlink()
    logf=open(LOG,"wb")
    proc=subprocess.Popen([str(EVMD),"start","--home",str(FRESH_HOME),"--chain-id","eip155:902024","--minimum-gas-prices","1anex","--evm.evm-chain-id","902024","--evm.min-tip","0","--pruning","nothing","--json-rpc.enable","true","--json-rpc.address","127.0.0.1:8545","--json-rpc.api","eth,txpool,personal,net,debug,web3"], stdout=logf, stderr=subprocess.STDOUT)
    evidence["node_pid"]=proc.pid
    pk=None
    try:
        # wait for valid block
        ready=False; deadline=time.time()+180
        while time.time()<deadline:
            time.sleep(2)
            try:
                rr=rpc_res("eth_blockNumber")
                if rr["ok"] and rr.get("result"): ready=True; break
            except: pass
        if not ready: die("RPC/block not ready", evidence)
        # verify chain twice, loopback only (we bound 127.0.0.1)
        c1=rpc_res("eth_chainId"); c2=rpc_res("eth_chainId")
        evidence["chain_checks"]=[c1,c2]
        if not (c1["ok"] and c2["ok"] and c1["result"]=="0xdc388" and c2["result"]=="0xdc388"):
            die(f"chainId ambiguity/failure: {c1} {c2}", evidence)
        ns=subprocess.run(["netstat","-ano"],capture_output=True,text=True,timeout=15)
        listeners=[l for l in (ns.stdout or "").splitlines() if ":8545" in l and "LISTENING" in l]
        evidence["pre_broadcast_8545_listeners"]=listeners
        if not listeners or not all(("127.0.0.1:8545" in l or "[::1]:8545" in l) for l in listeners):
            die(f"8545 not bound to loopback as expected: {listeners}", evidence)
        # get test key into var (never print)
        pexp=subprocess.run([str(EVMD),"keys","unsafe-export-eth-key","dev0","--keyring-backend","test","--home",str(FRESH_HOME)],capture_output=True,text=True,timeout=30)
        if pexp.returncode!=0: die("key export failed (redacted)", evidence)
        pk_raw=(pexp.stdout or "").strip().replace("\r","").replace("\n","")
        if not re.fullmatch(r'(0x)?[0-9a-fA-F]{64}', pk_raw): die("unexpected key format (redacted)", evidence)
        pk = pk_raw if pk_raw.startswith("0x") else "0x"+pk_raw
        pk_raw=None; pexp=None
        # clear old broadcast artifacts for determinism of capture? keep them but read latest
        env=os.environ.copy(); env["DEPLOYER_PRIVATE_KEY"]=pk
        # preflight: ensure script compiles in project
        bld=subprocess.run([str(FORGE),"build"],capture_output=True,text=True,timeout=300,cwd=str(AID),env=env)
        evidence["forge_build"]={"exit":bld.returncode,"stderr_tail":(bld.stderr or "")[-600:]}
        if bld.returncode!=0: die("forge build failed", evidence)
        log("broadcasting (loopback 127.0.0.1:8545, chain 0xdc388, --broadcast)")
        br=subprocess.run([str(FORGE),"script","script/DeployAid.s.sol:DeployAid","--sig","run()","--rpc-url",RPC,"--broadcast","-vvv"],
            capture_output=True,text=True,timeout=600,cwd=str(AID),env=env)
        evidence["forge_broadcast"]={"exit":br.returncode,"stdout_tail":(br.stdout or "")[-4000:],"stderr_tail":(br.stderr or "")[-2000:]}
        # clear key immediately
        env["DEPLOYER_PRIVATE_KEY"]=""; del env["DEPLOYER_PRIVATE_KEY"]; pk=None
        if br.returncode!=0: die("forge broadcast failed; see evidence tails", evidence)
        # read broadcast artifact
        bpath=AID/"broadcast"/"DeployAid.s.sol"/"902024"/"run-latest.json"
        if not bpath.exists():
            # find any
            cands=list((AID/"broadcast").rglob("run-latest.json")) if (AID/"broadcast").exists() else []
            evidence["broadcast_candidates"]=[str(c) for c in cands]
            if cands: bpath=cands[0]
        if bpath.exists():
            art=json.loads(bpath.read_text(encoding="utf-8",errors="replace"))
            evidence["broadcast_artifact_path"]=str(bpath)
            txs=art.get("transactions") or []
            receipts=art.get("receipts") or []
            # sanitize: don't store full traces with input blobs excessively; keep key fields
            def slim_tx(t):
                return {k:t.get(k) for k in ["hash","transactionType","contractName","contractAddress","function","arguments","tx"] if k in t}
            evidence["broadcast_transactions"]=[slim_tx(t) for t in txs]
            def slim_rc(r):
                return {k:r.get(k) for k in ["transactionHash","contractAddress","status","gasUsed","effectiveGasPrice","blockNumber","logs","cumulativeGasUsed","from","to"] if k in r}
            evidence["broadcast_receipts"]=[slim_rc(r) for r in receipts]
        else:
            evidence["broadcast_artifact_path"]=None
        # independent verification: find deployed contracts from receipts
        contracts={}
        for r in evidence.get("broadcast_receipts",[]):
            if r.get("contractAddress") and r.get("status") in ("0x1","1",1,"success",True):
                # heuristic by order: script deploys Registry then Factory
                pass
        # parse stdout for addresses as fallback
        out=(br.stdout or "")+"\n"+(br.stderr or "")
        addrs=re.findall(r'(0x[0-9a-fA-F]{40})', out)
        txhs=re.findall(r'(0x[0-9a-fA-F]{64})', out)
        evidence["parsed_addresses"]=list(dict.fromkeys(addrs))[:12]
        evidence["parsed_txhashes"]=list(dict.fromkeys(txhs))[:12]
        # identify registry/factory: call configuredChainId on candidates
        registry=None; factory=None
        for a in evidence["parsed_addresses"]:
            c=cast_call(a,"configuredChainId()(uint256)")
            if c["exit"]==0 and "902024" in c["stdout"]: registry=a; evidence["registry_configuredChainId"]=c
        for a in evidence["parsed_addresses"]:
            if a==registry: continue
            # factory has saltFor/predict
            c=cast_call(a,"saltFor(bytes32,bytes32)(bytes32)", "0x"+"11"*32, "0x"+"00"*32)
            if c["exit"]==0: factory=a; evidence["factory_saltFor_probe"]=c
        evidence["deployed"]={"registry":registry,"factory":factory}
        if registry:
            code=rpc_res("eth_getCode",[registry,"latest"]); evidence["registry_code"]={"ok":code["ok"],"len":len(code.get("result") or "") if code.get("result") else 0,"sha256":hashlib.sha256((code.get("result") or "").encode()).hexdigest() if code.get("result") else None}
            for sig,k in [("configuredChainId()(uint256)","registry_configuredChainId_confirm"),("totalRegistrations()(uint256)","registry_totalRegistrations"),("isRegistered(bytes32)(bool)","registry_native_probe")]:
                args=[]
                if "isRegistered" in sig:
                    # nativeId = keccak256(abi.encodePacked(uint256(902024),uint256(1)?)) - easier use script's behavior: call with a computed id? Better compute via cast keccak domain
                    dom=cast_call(registry,"configuredChainId()(uint256)") # not needed; compute offchain
                    # Aid.nativeId(902024): keccak(AID_V1||domain(902024,1)||T_NATIVE||bytes32(0)) ; domain=keccak(uint256 chain,uint256 ver)
                    d1=subprocess.run([str(CAST),"abi-encode","f(uint256,uint256)","902024","1"],capture_output=True,text=True,timeout=20,cwd=str(AID))
                    domh=subprocess.run([str(CAST),"keccak", (d1.stdout or "").strip()],capture_output=True,text=True,timeout=20,cwd=str(AID))
                    pre="0xa1"+(domh.stdout or "").strip().replace("0x","")+"00"+"00"*32
                    nid=subprocess.run([str(CAST),"keccak",pre],capture_output=True,text=True,timeout=20,cwd=str(AID))
                    nidv=(nid.stdout or "").strip(); evidence["native_id_computed"]=nidv
                    if nidv.startswith("0x"): args=[nidv]
                if args or "isRegistered" not in sig:
                    evidence[k]=cast_call(registry,sig,*args)
        if factory:
            code=rpc_res("eth_getCode",[factory,"latest"]); evidence["factory_code"]={"ok":code["ok"],"len":len(code.get("result") or "") if code.get("result") else 0,"sha256":hashlib.sha256((code.get("result") or "").encode()).hexdigest() if code.get("result") else None}
            # verify CREATE2 sample from DeployAid.s.sol: initCode=600a600c600039600a6000f3602a60005260206000f3, assetId=bytes32(uint256(0x1111))
            init="0x600a600c600039600a6000f3602a60005260206000f3"; asset="0x"+"00"*30+"1111"
            ih=subprocess.run([str(CAST),"keccak",init],capture_output=True,text=True,timeout=20,cwd=str(AID))
            inith=(ih.stdout or "").strip(); evidence["create2_init_hash"]=inith
            salt=cast_call(factory,"saltFor(bytes32,bytes32)(bytes32)",asset,inith); evidence["create2_salt"]=salt
            pred=cast_call(factory,"predict(bytes32,bytes32)(address)",(salt.get("stdout") or "").strip(),inith); evidence["create2_predicted"]=pred
            dep=cast_call(factory,"isDeployed(bytes32,bytes32)(bool)",(salt.get("stdout") or "").strip(),inith); evidence["create2_isDeployed"]=dep
            pred_addr=(pred.get("stdout") or "").strip()
            if re.fullmatch(r'0x[0-9a-fA-F]{40}',pred_addr):
                c2=rpc_res("eth_getCode",[pred_addr,"latest"]); evidence["create2_instance_code"]={"len":len(c2.get("result") or "") if c2.get("result") else 0,"has_code":(c2.get("result") not in (None,"0x","0x0"))}
        # receipts independent check
        for txh in evidence.get("parsed_txhashes",[])[:8]:
            rr=rpc_res("eth_getTransactionReceipt",[txh])
            if rr["ok"]: evidence.setdefault("tx_receipts_independent",[]).append({"tx":txh,"status":(rr["result"] or {}).get("status"),"contractAddress":(rr["result"] or {}).get("contractAddress"),"gasUsed":(rr["result"] or {}).get("gasUsed"),"logs_count":len((rr["result"] or {}).get("logs") or [])})
        evidence["status"]="SUCCESS" if (registry and factory and evidence.get("registry_configuredChainId_confirm",{}).get("exit")==0) else "PARTIAL"
    except SystemExit: raise
    except Exception as e:
        evidence["error"]=f"{type(e).__name__}: {e}"; evidence["status"]="ERROR"
    finally:
        try:
            # clear any lingering key vars
            if 'env' in dir() and isinstance(env,dict): env.pop("DEPLOYER_PRIVATE_KEY",None)
            pk=None
        except: pass
        log("stopping node (pid-scoped only)")
        try:
            if proc and proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=25)
                except: proc.kill(); proc.wait(timeout=10)
        except Exception as e: evidence["stop_error"]=str(e)
        try: logf.close()
        except: pass
        time.sleep(2)
        ns=subprocess.run(["netstat","-ano"],capture_output=True,text=True,timeout=15)
        listeners=[l for l in (ns.stdout or "").splitlines() if any(p in l for p in [":8545",":8546",":26657",":26656",":1317",":9090"]) and "LISTENING" in l]
        evidence["post_stop_listeners"]=listeners
        if listeners and proc and proc.pid and any(str(proc.pid) in l for l in listeners):
            subprocess.run(["taskkill","/PID",str(proc.pid),"/F"],capture_output=True,timeout=15)
            time.sleep(1)
            ns2=subprocess.run(["netstat","-ano"],capture_output=True,text=True,timeout=15)
            evidence["post_force_listeners"]=[l for l in (ns2.stdout or "").splitlines() if any(p in l for p in [":8545",":8546",":26657",":26656",":1317",":9090"]) and "LISTENING" in l]
        EVIDENCE.write_text(json.dumps(evidence,indent=2,default=str))
    log(f"status={evidence['status']} evidence={EVIDENCE}")
    print(json.dumps({"status":evidence["status"],"evidence":str(EVIDENCE),"registry":evidence.get("deployed",{}).get("registry"),"factory":evidence.get("deployed",{}).get("factory"),"abort":evidence.get("abort_reason"),"error":evidence.get("error")},indent=2))

if __name__=="__main__": main()
