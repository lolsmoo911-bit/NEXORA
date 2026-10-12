# NEXORA — copy/paste commands (local, inside this Replit)

**These commands only work from inside this workspace.** There is no public endpoint.
For the full picture see `REPLIT-DEPLOYMENT.md`.

## Chain identity

```
cosmos chain-id   nexora-devnet-1
EVM chain-id      902024   (0xdc388)
denomination      anex, 18 decimals
genesis sha256    21a266af5577577f77ff8930a2a75469e8a2ddcdfb2a641edb0b034faccd83ef
```

## Set up (once)

```bash
export PATH=/home/runner/workspace/nexora-chain/cosmos-evm/build:$PATH
export WORK=/home/runner/workspace/nexora-chain/testnet
export COSMOS_EVM_DIR=/home/runner/workspace/nexora-chain/cosmos-evm
export EVM=/home/runner/workspace/nexora-chain/cosmos-evm/build/evmd
```

## Start / stop

```bash
bash /home/runner/workspace/nexora-chain/NEXORA/ci/testnet/start-local-node.sh   # start 4 validators
bash /home/runner/workspace/nexora-chain/NEXORA/ci/testnet/stop.sh              # graceful stop
```

## Block height

```bash
curl -s http://127.0.0.1:26657/status \
  | python3 -c 'import json,sys;s=json.load(sys.stdin)["result"]["sync_info"];print("height",s["latest_block_height"],"catching_up",s["catching_up"])'
```

## Validator status — all four app_hashes at the same height

```bash
HS=""; for i in 0 1 2 3; do P=$((26657+2*i)); \
  H=$(curl -s http://127.0.0.1:$P/status | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["sync_info"]["latest_block_height"])'); \
  HS="$HS $H"; done
M=$(tr ' ' '\n' <<< $HS | grep -E '^[0-9]+$' | sort -n | head -1)
echo "comparing at height $M"
for i in 0 1 2 3; do P=$((26657+2*i)); \
  curl -s "http://127.0.0.1:$P/block?height=$M" \
  | python3 -c "import json,sys;print('node$i',json.load(sys.stdin)['result']['block']['header']['app_hash'])"; done
```

All four hashes must be identical. Read them at the **same** height — reading each node's
*latest* in sequence races block production and reports a false mismatch.

## Validator set and voting power

```bash
curl -s "http://127.0.0.1:26657/validators?per_page=10" | python3 -c '
import json,sys
v=json.load(sys.stdin)["result"]["validators"]
print("total voting power:",sum(int(x["voting_power"]) for x in v))
for x in v: print(" ",x["address"][:24],x["voting_power"])'
```

## P2P peers

```bash
for i in 0 1 2 3; do P=$((26657+2*i)); \
  echo -n "node$i: "; curl -s http://127.0.0.1:$P/net_info \
  | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["result"]["peers"]),"peers")'; done
```

## Balance

```bash
H=/home/runner/workspace/nexora-chain/testnet/node0
export PATH=/home/runner/workspace/nexora-chain/cosmos-evm/build:$PATH
ADDR=$(evmd keys show dev3 -a --keyring-backend test --home $H)
evmd q bank balances $ADDR --node http://127.0.0.1:26657 -o json
```

## Test transfer

```bash
export PATH=/home/runner/workspace/nexora-chain/cosmos-evm/build:$PATH
H=/home/runner/workspace/nexora-chain/testnet/node0
FROM=$(evmd keys show val0 -a --keyring-backend test --home $H)
TO=$(evmd keys show dev3  -a --keyring-backend test --home $H)
TX=$(evmd tx bank send $FROM $TO 250000000000000000anex \
  --chain-id nexora-devnet-1 --keyring-backend test --home $H \
  --node http://127.0.0.1:26657 \
  --gas-prices 2000000000anex --gas 200000 -y -o json)
TXH=$(echo "$TX" | python3 -c 'import json,sys;print(json.load(sys.stdin)["txhash"])')
echo "submitted $TXH"; sleep 12
evmd q tx $TXH --node http://127.0.0.1:26657 -o json \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print("code",repr(d.get("code")),"height",d.get("height"),"gas",d.get("gas_used"),"/",d.get("gas_wanted"))'
```

**Use `--gas-prices`, not `--fees`.** `--fees` is a total; `--gas-prices` is a price per gas
unit. Confusing them gives 10000anex per gas against a base fee that starts at 1e9, and the
transaction is rejected in CheckTx with `code: 13`.

**Fee model, measured:** `cost = gas_wanted × gas_price`. There is **no unused-gas refund** —
a transaction that consumes 88057 of a 200000 limit is still charged for all 200000.

## EVM JSON-RPC

```bash
for m in eth_chainId eth_blockNumber net_version; do
  echo -n "$m -> "
  curl -s -X POST http://127.0.0.1:8545 -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"$m\",\"params\":[],\"id\":1}"; echo
done
```

## HTTP gateway (local only — Replit free cannot expose it)

```bash
cd /home/runner/workspace && node nexora-rpc-gateway.mjs
# then, from inside:
curl -s http://127.0.0.1:3000/chain-info
curl -s http://127.0.0.1:3000/cosmos/status
curl -s -X POST http://127.0.0.1:3000/evm -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
```

## Wallet settings (for when a real endpoint exists)

```
Network name      NEXORA Testnet
Cosmos chain-id   nexora-devnet-1
EVM chain-id      902024  (0xdc388)
Currency symbol   ANEX
Decimals          18
RPC URL           <not available — free Replit cannot expose one>
EVM RPC URL       <not available>
```

## Keys — read this before using any of the above

`val0`–`val3` and `dev3` are recovered from the **upstream public test mnemonics**. They are
published in cosmos/evm and must never hold value. Nothing here is for real funds.