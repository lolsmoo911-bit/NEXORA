#!/usr/bin/env python3
"""Custorium exchange E2E battery — real chain flows against the RUNNING exchange.

Usage: python3 source/nexora-exchange/e2e_battery.py   (exchange + chain must be up)
Covers: faucet (real mints) → self-deposit (real ERC20 transfer, watcher credit)
        → signed session (EIP-191 via cast) → LIMIT rest/cancel → MARKET buy/sell
        round trip → withdrawal (real custody transfer) → backing invariant check.
"""
import json, subprocess, sys, time, urllib.request

X = "http://127.0.0.1:4173"
RPC = "http://127.0.0.1:8545"
CAST = ".foundry/versions/foundry-rs/foundry/v1.8.5/cast"
PASS, FAIL = 0, 0

def ok(m):
    global PASS; PASS += 1; print(f"  ✓ {m}")

def bad(m):
    global FAIL; FAIL += 1; print(f"  ✗ {m}")

def cast(*args, timeout=90):
    return subprocess.run([CAST, *args], capture_output=True, text=True, timeout=timeout).stdout.strip()

def api(path, body=None, token=None, timeout=90):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(X + path, data=data, method="POST" if data is not None else "GET")
    req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try: return json.loads(e.read().decode())
        except Exception: return {"error": f"HTTP {e.code}"}

def run(name, fn):
    global PASS, FAIL
    print(f"\n== {name}")
    try:
        fn()
    except Exception as e:
        bad(f"{name}: {e}")

print("Custorium exchange E2E battery")

# --- fresh wallet
run("fresh wallet", lambda: None)
w = json.loads(cast("wallet", "new", "--json"))["data"][0]
PK, ADDR = w["private_key"], w["address"]
print(f"  wallet: {ADDR}")

# --- faucet
def t_faucet():
    r = api("/api/faucet", {"address": ADDR})
    assert "error" not in r, r.get("error")
    ok("faucet minted (real mints from admin)")
run("faucet (real mints from admin)", t_faucet)

health = api("/api/health")
CUST = health["custody"]
NUSD = health["tokens"]["nUSD"]

# --- self-deposit (real ERC20 transfer, watcher credits the ledger)
def t_deposit():
    cast("send", NUSD, "transfer(address,uint256)", CUST, str(5000 * 10**18),
         "--private-key", PK, "--gas-price", "2200000000", "--json")
    deadline = time.time() + 40
    while time.time() < deadline:
        acc = api(f"/api/account?address={ADDR}")["account"]
        row = next((b for b in acc["balances"] if b["symbol"] == "nUSD"), {})
        if row.get("available", row.get("balance", 0)) > 1000:
            ok(f"deposit credited (nUSD available: {row.get('available')})")
            return
        time.sleep(3)
    raise RuntimeError("deposit not credited in 40s")
run("self-deposit 5000 nUSD to custody (signed ERC20 transfer)", t_deposit)

# --- signed session (challenge → personal_sign → ecrecover)
def t_session():
    global TOKEN
    nonce = api("/api/auth/challenge", {"address": ADDR})["nonce"]
    sig = cast("wallet", "sign", nonce, "--private-key", PK)
    r = api("/api/auth/verify", {"address": ADDR, "nonce": nonce, "sig": sig})
    TOKEN = r.get("token", "")
    assert TOKEN, r.get("error")
    ok("session verified (EIP-191 ecrecover on-chain precompile)")
TOKEN = None
run("signed session", t_session)

def order(body):
    return api("/api/orders", {"address": ADDR, **body}, token=TOKEN)

# --- LIMIT rest + cancel
def t_limit():
    r = order({"instrument": "XAUUSD", "side": "buy", "type": "limit", "price": 2100, "quantity": 0.01})
    assert "error" not in r, r.get("error")
    oid = (r.get("order") or {}).get("id")
    assert oid, r
    c = api("/api/orders/cancel", {"address": ADDR, "orderId": oid}, token=TOKEN)
    assert "error" not in c, c.get("error")
    ok(f"limit order rested + cancelled (id={oid})")
run("LIMIT buy XAUUSD @2100 x0.01 (resting) + cancel", t_limit)

# --- MARKET buy (fills from custody K inventory)
def t_buy():
    r = order({"instrument": "XAUUSD", "side": "buy", "type": "market", "quantity": 0.01})
    assert "error" not in r, r.get("error")
    acc = api(f"/api/account?address={ADDR}")["account"]
    xau = next((b for b in acc["balances"] if b["symbol"] == "nXAU"), {}).get("available", 0)
    assert xau > 0, f"no nXAU credited: {xau}"
    ok(f"market buy filled (nXAU available: {xau})")
run("MARKET buy XAUUSD x0.01 (fills from custody K inventory)", t_buy)

# --- MARKET sell back (round trip)
def t_sell():
    acc = api(f"/api/account?address={ADDR}")["account"]
    xau = next((b for b in acc["balances"] if b["symbol"] == "nXAU"), {}).get("available", 0)
    assert xau > 0, "nothing to sell"
    r = order({"instrument": "XAUUSD", "side": "sell", "type": "market", "quantity": xau})
    assert "error" not in r, r.get("error")
    acc = api(f"/api/account?address={ADDR}")["account"]
    nusd = next((b for b in acc["balances"] if b["symbol"] == "nUSD"), {}).get("available", 0)
    assert nusd > 1000, f"nUSD after round trip: {nusd}"
    ok(f"round trip settled (nUSD available: {nusd})")
run("MARKET sell nXAU back (round trip)", t_sell)

# --- withdrawal (real custody ERC20 transfer)
def t_withdraw():
    r = api("/api/withdraw", {"address": ADDR, "symbol": "nUSD", "amount": 100, "to": ADDR}, token=TOKEN)
    assert "error" not in r, r.get("error")
    time.sleep(6)
    raw = cast("call", NUSD, "balanceOf(address)(uint256)", ADDR, "--rpc-url", RPC).split()[0]
    bal = int(raw, 16) if raw.startswith("0x") else int(raw or 0)
    assert bal >= 100 * 10**18, f"on-chain nUSD: {bal}"
    ok(f"withdrawal landed on-chain (wallet nUSD: {bal / 10**18:.2f})")
run("withdraw 100 nUSD to wallet (real custody transfer)", t_withdraw)

# --- backing invariant
def t_backing():
    b = api("/api/backing")
    s = b.get("summary", {})
    assert b.get("allBacked") and s.get("tokens", 0) > 0, b
    ok(f"backing invariant holds (C = L + K, {s.get('tokens')} tokens checked)")
run("backing invariant (custody C = ledger L + K)", t_backing)

print(f"\nBATTERY: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
