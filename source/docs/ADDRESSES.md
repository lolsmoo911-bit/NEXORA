# Why `listen_addr` shows `127.0.0.1` — and why that is correct

## What you saw

```json
"listen_addr": "127.0.0.1:26656",
"other": { "rpc_address": "tcp://127.0.0.1:26657" }
```

## Why it is not a defect

Both fields describe the node's **own loopback sockets**:

- `listen_addr` — where CometBFT's **P2P** listener binds. This is node-to-node traffic
  between the four validators.
- `rpc_address` — the `rpc.laddr` value, i.e. where CometBFT's **own** RPC server binds.

The container runs behind NAT on a free Replit and has no routable inbound address. Every
listener genuinely is on loopback, so loopback is the truth.

## Why it must NOT be changed to the public URL

It would break the chain, not improve it:

1. **The node would try to LISTEN on that name.** `rpc.laddr` is a bind address, not a label.
   Pointing it at the Replit dev domain makes the node resolve a hostname it cannot bind, and
   it fails to start.

2. **The P2P mesh would collapse.** CometBFT publishes `listen_addr` so peers know where to
   dial. An address no peer can reach means zero peers, which means no quorum, which means no
   blocks — the exact failure this project spent a day already fixing.

3. **It would simply be untrue.** There is no process listening on a public port. The Replit
   dev domain terminates TLS in front of the app; nothing is bound to it inside.

## Where the public URL actually lives

External access is a gateway, not a bound port:

```
internet ──HTTPS──> Replit dev domain ──> api-server ──> 127.0.0.1:26657 / :8545
```

So the public address is now returned explicitly by `/api/nexora/info`, derived from the
request's own `Host` header, so it is always the origin you actually reached:

```bash
curl -s https://<dev-domain>/api/nexora/info
```

```json
"publicUrls": {
  "origin":       "https://<dev-domain>",
  "cosmosRpc":    "https://<dev-domain>/api/nexora/cosmos",
  "evmJsonRpc":   "https://<dev-domain>/api/nexora/evm",
  "chainInfo":    "https://<dev-domain>/api/nexora/info"
},
"wallet": {
  "networkName": "NEXORA Testnet",
  "chainId": 902024, "chainIdHex": "0xdc388",
  "currencySymbol": "ANEX", "decimals": 18,
  "rpcUrl": "https://<dev-domain>/api/nexora/evm"
}
```

The same response states the capabilities plainly rather than leaving them to be inferred:

```json
"capabilities": {
  "cosmosSide": "read-only CometBFT endpoints",
  "evmSide": "full JSON-RPC forwarded, including eth_sendRawTransaction",
  "websocket": false,
  "restApi": false,
  "blockExplorer": false,
  "p2pExternallyReachable": false,
  "alwaysOn": false
}
```

## The honest summary

| Question | Answer |
|---|---|
| Is the node reachable from the internet? | **Yes**, through the gateway URL |
| Does `listen_addr` show that URL? | **No, and it must not** — it binds loopback by necessity |
| Are there usable `persistent_peers`? | **No** — P2P is loopback-only |
| Is it always on? | **No** — a free Replit sleeps when idle |

If external P2P is ever needed, it requires a host with a routable inbound address. Until
then, the four-validator mesh is internal to one machine and the public surface is HTTP only.