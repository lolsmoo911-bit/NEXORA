#!/usr/bin/env python3
"""Independent verification of the 2026-11-07 AID broadcast against the same fresh home.
Restarts evmd on workbench/aid-deploy/fresh-home-2026-11-07 (loopback), verifies
deployments/receipts/code/calls/events, stops only own PID, updates evidence."""
import json, subprocess, time, urllib.request as u, hashlib, re, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]; WB=ROOT/"workbench"; AID=WB/"aid-deploy"
EVMD=WB/"toolchain/bin/evmd.exe"; CAST=WB/"toolchain/foundry/bin-content/cast.exe"
HOME=AID/"fresh-home-2026-11-07"; RPC="http://127.0.0.1:8545"; EVID=AID/"observations-2026-11-07-broadcast.json"
REG="0x3d641a2791533b4a0000345ea8d509d01e1ec301"; FAC="0x07aa076883658b7ed99d25b1e6685808372c8fe2"
NATIVE="0x49d41c535f2cd20369abc4716c440120dd37cdf6aa748555288f6487d8bd5cf6"
CREATE2_INSTANCE="0xbd19e1d5c6391ad767b99282af241f8de4b5f508"
TXS=["0xbfb183377a8f7ecfb53203eca70dff4a8679f2e3ea80a68d60c35e8cdee19e8e","0x46f878dad3ae07ce02173183f01a762801b1b0518a38160a3aab969197b779ef","0x7eace5e48596620bdebe04d56055fffe68c802d47fa4acca62f86c7bcca90bdf","0x8e1016b146b34cdd3a5705d96d18f6fa1826b9440903ed4210273b548a666717"]
def rpc(m,p=None):
    req=u.Request(RPC,data=json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p or []}).encode(),headers={"Content-Type":"application/json"})
    with u.urlopen(req,timeout=15) as r: return json.loads(r.read())
def call(to,sig,*a):
    p=subprocess.run([str(CAST),"call",to,sig,*a,"--rpc-url",RPC],capture_output=True,text=True,timeout=30,cwd=str(AID))
    return {"exit":p.returncode,"out":(p.stdout or "").strip(),"err":(p.stderr or "")[:300]}
ev=json.loads(EVID.read_text())
logf=open(AID/"verify-broadcast-node.log","wb")
proc=subprocess.Popen([str(EVMD),"start","--home",str(HOME),"--chain-id","eip155:902024","--minimum-gas-prices","1anex","--evm.evm-chain-id","902024","--evm.min-tip","0","--pruning","nothing","--json-rpc.enable","true","--json-rpc.address","127.0.0.1:8545","--json-rpc.api","eth,txpool,personal,net,debug,web3"],stdout=logf,stderr=subprocess.STDOUT)
v={"node_pid":proc.pid,"status":"running"}
try:
    ready=False
    for _ in range(90):
        time.sleep(2)
        try:
            b=rpc("eth_blockNumber")
            if "result" in b and b["result"]: ready=True; break
        except: pass
    if not ready: raise RuntimeError("not ready")
    v["chainId"]=rpc("eth_chainId")["result"]; v["block"]=rpc("eth_blockNumber")["result"]
    if v["chainId"]!="0xdc388": raise RuntimeError("wrong chain")
    for tx in TXS:
        r=rpc("eth_getTransactionReceipt",[tx])["result"]; v.setdefault("receipts",[]).append({"tx":tx,"status":r.get("status"),"contractAddress":r.get("contractAddress"),"to":r.get("to"),"gasUsed":r.get("gasUsed"),"logs":len(r.get("logs") or []),"from":r.get("from")})
    for label,addr in [("registry",REG),("factory",FAC),("create2_instance",CREATE2_INSTANCE)]:
        code=rpc("eth_getCode",[addr,"latest"])["result"]; v[label+"_code"]={"len":len(code)-2 if code.startswith("0x") else 0,"sha256":hashlib.sha256(code.encode()).hexdigest(),"has_code":code not in ("0x","0x0",None,"")}
    v["registry_configuredChainId"]=call(REG,"configuredChainId()(uint256)")
    v["registry_totalRegistrations"]=call(REG,"totalRegistrations()(uint256)")
    v["registry_isRegistered_native"]=call(REG,"isRegistered(bytes32)(bool)",NATIVE)
    v["registry_verify_native"]=call(REG,"verify(bytes32,bytes32)(bool)",NATIVE,"0x"+"00"*32)
    # CREATE2 salt/predict check
    init="0x600a600c600039600a6000f3602a60005260206000f3"; asset="0x"+"00"*30+"1111"
    ih=subprocess.run([str(CAST),"keccak",init],capture_output=True,text=True,timeout=20).stdout.strip()
    salt=call(FAC,"saltFor(bytes32,bytes32)(bytes32)",asset,ih)
    pred=call(FAC,"predict(bytes32,bytes32)(address)",salt["out"],ih)
    dep=call(FAC,"isDeployed(bytes32,bytes32)(bool)",salt["out"],ih)
    v["create2"]={"init_hash":ih,"salt":salt,"predicted":pred,"isDeployed":dep,"expected_instance":CREATE2_INSTANCE,"predicted_matches":pred["out"].lower()==CREATE2_INSTANCE.lower()}
    v["status"]="PASS" if all(r["status"]=="0x1" for r in v["receipts"]) and v["registry_code"]["has_code"] and v["factory_code"]["has_code"] and v["create2_instance_code"]["has_code"] and "902024" in v["registry_configuredChainId"]["out"] and "true" in v["registry_isRegistered_native"]["out"].lower() and "true" in v["create2"]["isDeployed"]["out"].lower() and v["create2"]["predicted_matches"] else "FAIL"
except Exception as e:
    v["error"]=str(e); v["status"]="ERROR"
finally:
    try:
        if proc.poll() is None: proc.terminate(); proc.wait(timeout=20)
    except: 
        try: proc.kill()
        except: pass
    try: logf.close()
    except: pass
    time.sleep(2)
    ns=subprocess.run(["netstat","-ano"],capture_output=True,text=True,timeout=15)
    v["post_stop_listeners"]=[l for l in (ns.stdout or "").splitlines() if ":8545" in l and "LISTENING" in l]
ev["independent_verification"]=v
ev["deployed"]={"registry":REG,"factory":FAC,"create2_instance":CREATE2_INSTANCE,"native_asset_id":NATIVE}
ev["status"]="BROADCAST_SUCCESS_VERIFIED" if v.get("status")=="PASS" else "BROADCAST_DONE_VERIFICATION_"+v.get("status","UNKNOWN")
EVID.write_text(json.dumps(ev,indent=2,default=str))
print(json.dumps({"status":ev["status"],"verify":v.get("status"),"registry":REG,"factory":FAC,"create2":CREATE2_INSTANCE,"listeners_after":v.get("post_stop_listeners")},indent=2))
