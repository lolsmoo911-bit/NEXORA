# NEXORA Testnet — Trust Wallet (Android) guide

Testnet only. Valueless test tokens. NEXORA is **not** listed on Trust Wallet and is not
tradable. Cost: **$0**.

---

## 1. Endpoint verified

Base URL:

```
https://c60e4db5-67b2-4765-8c6b-0a614271da9e-00-21s1bbx8huijp.janeway.replit.dev/api/nexora
```

Verified from outside the server:

| Method | Result |
|---|---|
| `eth_chainId` | `0xdc388` (= 902024) ✅ |
| `eth_blockNumber` | `0x1d32` (= 7474) ✅ |
| `eth_syncing` | `false` ✅ |
| `eth_gasPrice` | `0x0` |
| `eth_maxPriorityFeePerGas` | `0x0` |
| `eth_getBalance` (funded test address) | `0x36403236ccdf219716` = **1000.75 ANEX** ✅ |
| `eth_getCode` | `0x` (EOA) ✅ |
| `eth_getTransactionCount` | `0x0` ✅ |

Everything a wallet calls on connect is answered correctly.

## 2. Exact configuration to enter

| Field | Value |
|---|---|
| Network name | **NEXORA Testnet** |
| Chain ID (EVM) | **902024** |
| Chain ID (hex) | **0xdc388** |
| Currency symbol | **ANEX** |
| Decimals | **18** |
| RPC URL | `https://c60e4db5-67b2-4765-8c6b-0a614271da9e-00-21s1bbx8huijp.janeway.replit.dev/api/nexora/evm` |
| Block explorer | *(none — not deployed)* |
| EVM chain ID field | put **902024** or **0xdc388**, whichever the app accepts |

The Cosmos chain-id, if an app asks for it separately: `nexora-devnet-1`.

---

## 3. What works and what does not — read this first

**You will be able to:**
- Add the network
- See NEXORA Testnet selected and active
- See your addresses
- See block numbers advancing
- See **0 ANEX** in each new wallet (correct — they are empty)

**You will not be able to send anything.** Not because the endpoint blocks it, but because
**your new wallets hold 0 ANEX**, and a transaction from an empty account is rejected by the
network.

### Correction: the gateway is NOT read-only

Earlier documentation in this repo stated the public endpoint was read-only. **That was
wrong and has been corrected.** The proxy forwards the whole EVM JSON-RPC surface. Testing
`eth_sendRawTransaction` produces errors that come from the node's Go/goth code
(`json: cannot unmarshal hex string…`, `rlp: value size exceeds…`), not from a proxy block.
A correctly signed transaction would be broadcast.

So the barrier is **funding, not the gateway**. Sending needs a funded key — see §6.

---

## 4. Create three test wallets — safely

Do this **inside Trust Wallet on your phone only**. Never type a seed phrase into a website,
a chat, a terminal, or GitHub. Nobody — including me — needs your recovery phrase. If any
message ever asks for it, it is a scam.

1. Open Trust Wallet.
2. Top-right **☰ / profile icon** → **Add / Create wallet** → **Create new wallet**.
3. Repeat until you have **three** wallets. Name them by purpose, for example:
   `NEX Test A`, `NEX Test B`, `NEX Test C`.
4. Each gets its own 12-word phrase, shown once. Write it on paper, offline.
5. Go to each wallet's **Receive / Share** screen and note the public address.

You need **only public addresses** for testing. That is all this guide asks you for. Public
addresses are safe to share.

For the record, these are the three addresses to use:

```
Sender    <your wallet A address>
Receiver  <your wallet B address>
Testing   <your wallet C address>
```

If you want to see a **non-zero** balance while testing, this address already holds test
tokens and is safe to view on-chain:

```
0x498B5AeC5D439b733dC2F58AB489783A23FB26dA   1000.75 ANEX
```

You do not need its key to *see* the balance, but a wallet only displays balances for
addresses it controls. So expect **0 ANEX** on your own wallets — that is the correct result.

---

## 5. Add the network on Android

Trust Wallet's custom-network screen has moved between versions, and some builds do not
expose it. Try in this order and stop at the first that works.

**Trust Wallet (newer Android builds)**
1. Trust Wallet → top-right **☰** → **Settings**
2. Scroll to **Networks** (or **Preferences → Networks**)
3. Tap **+** / **Add network**
4. Fill in the table from §2, tap **Save**

**If Trust Wallet has no add-network option:** that build does not support custom networks.
Use **MetaMask** (free, Android), which does, and is the more reliable path regardless:
1. Install MetaMask from Google Play
2. Menu → **Settings** → **Network** → **Add custom network**
3. Fill in §2, tap **Save**, then **Switch to it**

Do not install a wallet from a link in a message. Install only from Google Play or the
official site.

---

## 6. Verify it worked

1. **Network active** — NEXORA Testnet appears selected in the network switcher.
2. **Reachable** — the app shows a block number that increases over a minute. If it shows
   `0` or spins, the RPC URL is wrong or the Replit is asleep.
3. **Balance visible** — 0 ANEX on each new wallet. That is correct.
4. **Independent check** — paste into a browser or a term:

```bash
BASE=https://c60e4db5-67b2-4765-8c6b-0a614271da9e-00-21s1bbx8huijp.janeway.replit.dev/api/nexora
curl -s -X POST $BASE/evm -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
```

Expect `{"result":"0xdc388"}`.

---

## 7. What must happen before a transaction can be broadcast

Sending is blocked by **funding**, not by the endpoint. Required, in order:

1. **Give the test wallets a balance.** The only funded key in this environment is a
   genesis test account derived from an upstream **public** test mnemonic. That account
   (`…FB26dA`, 1000.75 ANEX) should not be imported into a wallet you intend to use.
   The clean path is a faucet: a small script or service that sends test tokens to an address
   you supply. **That faucet does not exist yet.**

2. **Decide the fee.** `eth_gasPrice` currently reports `0x0` because the feemarket base fee
   has decayed to zero. That needs confirming as intentional before relying on it — a zero gas
   price is unusual and wallets may reject or mis-estimate.

3. **Confirm the wallet can sign for this chain.** Some wallets refuse to sign on an unknown
   chain until it is marked as a test network.

4. **End-to-end test from the phone.** Send a small amount A → B, then confirm both balances
   and the transaction status before anything larger.

Until step 1 exists, a transaction from your wallet will fail with an insufficient-funds
error — which is the chain behaving correctly, not a bug.

---

## 8. Limitations to keep in mind

| Limitation | Detail |
|---|---|
| Free Replit sleeps | The validators and endpoint stop after inactivity. If the wallet cannot connect later, check this first — it is not a wallet fault. |
| Single host | All four validators on one machine. |
| Read paths only through Cosmos side | `/cosmos/*` is CometBFT read endpoints; there is no REST API and no WebSocket. |
| Not listed | NEXORA is not on Trust Wallet's registry and cannot be traded. |
| Test tokens | No value. No mainnet. No purchase of tokens. |

If the endpoint stops responding, tell me and I will bring the validators back up.