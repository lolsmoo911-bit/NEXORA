# NEXORA Testnet — wallet setup (Trust Wallet + MetaMask, Android)

Testnet only. Valueless test tokens. NEXORA is **not** listed in any wallet's registry and
is **not tradable**. Cost: **$0**.

Both wallets use the same values. Only the menu path differs.

---

## Values to enter — identical for both wallets

| Field | Value |
|---|---|
| Network name | **NEXORA Testnet** |
| Chain ID | **902024** |
| Chain ID (hex) | **0xdc388** |
| Currency symbol | **ANEX** |
| Decimals | **18** |
| RPC URL | `https://c60e4db5-67b2-4765-8c6b-0a614271da9e-00-21s1bbx8huijp.janeway.replit.dev/api/nexora/evm` |
| Explorer URL | *(leave empty — none is deployed)* |

Enter the RPC URL **exactly as written, with no trailing slash**.

---

## Trust Wallet (Android)

1. Trust Wallet → top-right **☰** → **Settings**
2. Scroll to **Networks** (some builds: **Preferences → Networks**)
3. Tap **+** / **Add network**
4. Fill in the table above → **Save**
5. Use the network switcher at the top of the wallet to select **NEXORA Testnet**

If your build has no add-network screen, it does not support custom networks — use MetaMask,
which is the better-supported option on Android anyway.

## MetaMask (mobile app)

1. Open MetaMask → **☰** (top left)
2. **Settings** → **Network** → **Add custom network**
3. Fill in the table above
4. **Save**, then **Switch to NEXORA Testnet**

## MetaMask (browser extension)

Same values, same fields. Add it under **Settings → Networks → Add custom network**, or
Network settings → **Add a custom network**. Pre-flight works — the endpoint answers
`OPTIONS` with `204` and `access-control-allow-origin: *`, verified.

---

## Before you judge it: check the endpoint is awake

A free Replit **suspends when idle**. My server-side tests keep it awake; a phone does not.
A request arriving during suspension fails exactly like a typo, and both wallets report
"could not fetch chain ID".

Run this on your phone's browser (not in the wallet) immediately before testing:

```
https://c60e4db5-67b2-4765-8c6b-0a614271da9e-00-21s1bbx8huijp.janeway.replit.dev/api/nexora/evm
```

A GET there returns **`405`** — that is the correct, healthy response, and it means the
chain is awake. If the page shows a Replit error, a login page, or spins, the Repl is asleep:
wait 30–60 seconds and reload.

---

## Verified behaviour of the endpoint

Tested from outside against the live URL. Full matrix in
[`ENDPOINT-VERIFICATION.md`](ENDPOINT-VERIFICATION.md).

| Check | Result |
|---|---|
| `eth_chainId` | `0xdc388` (902024) |
| `net_version` | `902024` |
| `eth_blockNumber` | advancing |
| `eth_getBalance` | correct |
| `Accept-Encoding` — none / gzip / identity / br / zstd / `*` | HTTP 200, valid JSON every time |
| HTTP/2 and HTTP/1.1 | both 200 |
| Wallet user-agents (Trust Wallet, MetaMask, okhttp) | 200 |
| CORS preflight | 204 + `access-control-allow-origin: *` |
| Response `id` echoed | yes |

**The endpoint is POST-only.** A `GET` returns `405` by design.

### What I could not test

I cannot install or run Trust Wallet or MetaMask from this environment. The results above
are HTTP-level. They do not prove a wallet app completes its own chain-ID check — a wallet
can also fail from its own cached result, TLS pinning, or timing out against a slow or waking
endpoint. If a wallet fails while the checks above all pass, the wallet is the remaining
variable, and clearing its network data or reinstalling is the next step.

---

## Sending

New wallets hold **0 ANEX**, so a send fails with insufficient funds — that is the chain
behaving correctly.

The endpoint does **not** block `eth_sendRawTransaction`; an earlier claim that it was
"read-only" was wrong and has been corrected in `PUBLIC-ENDPOINTS.md`. The blocker is
funding. A faucet does not exist yet.

---

## Test wallets — create them safely

Create wallets **inside the app on your phone**. Never enter a recovery phrase into a website,
a chat, a terminal, or a repository. Nobody needs yours. If anything asks for it, it is fraud.

1. Trust Wallet → **☰** → **Add/Create wallet** → **Create new**
2. Repeat ×3 — e.g. `NEX Test A`, `NEX Test B`, `NEX Test C`
3. Write each 12-word phrase on paper, offline
4. Note each **public address** from Receive

Only public addresses are needed for testing, and they are safe to share. To see a non-zero
balance on-chain:

```
0x498B5AeC5D439b733dC2F58AB489783A23FB26dA    1000.75 ANEX
```

You do not need its key. Your own wallets will correctly show `0 ANEX`.

---

## Limitations

| Limitation | Detail |
|---|---|
| Not always-on | Free Replit sleeps when idle. This is the most likely cause of an intermittent wallet failure. |
| Single host | Four validators, one machine. |
| No explorer | No block/tx explorer is deployed. |
| No WebSocket | The gateway is HTTP only. |
| Read paths on Cosmos side | `/cosmos/*` is CometBFT read endpoints; no REST API. |
| Not listed | NEXORA appears in no wallet registry and cannot be bought or sold. |