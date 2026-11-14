#!/bin/bash
# Custorium exchange + chain runner — durable and idempotent.
#
# Replaces the old /tmp restart script: runtime state lives in source/nexora-exchange/state/
# (gitignored) so it survives environment resets, and every child is started with setsid so
# it survives session kills. Run it detached; it exits after ensuring both services are up.
#
#   setsid nohup bash source/nexora-exchange/run.sh >> source/nexora-exchange/state/run.log 2>&1 &
#
# The devnet started here is the exchange module's own bootstrap home (bootstrap.mjs);
# contracts + balances persist in the durable home across restarts.
cd "$(dirname "$0")/../.." || exit 1   # workspace root
STATE=source/nexora-exchange/state
EVMD=nexora-chain/cosmos-evm/build/evmd
PORT="${PORT:-4173}"
rpc() { curl -s --max-time 3 -X POST http://127.0.0.1:8545 -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' 2>/dev/null | grep -q 0xdc388; }

if ! rpc; then
  echo "$(date -Is) RPC down — starting evmd on durable home"
  setsid nohup "$EVMD" start \
    --home "$STATE/chain-home" \
    --chain-id eip155:902024 \
    --minimum-gas-prices 1anex \
    --evm.evm-chain-id 902024 \
    --evm.min-tip 0 \
    --pruning nothing \
    --json-rpc.enable true \
    --json-rpc.address 127.0.0.1:8545 \
    --json-rpc.api eth,txpool,personal,net,debug,web3 \
    >> "$STATE/chain.log" 2>&1 < /dev/null &
  for _ in $(seq 1 60); do rpc && break; sleep 2; done
fi
if ! rpc; then echo "$(date -Is) FATAL: RPC did not come up (see $STATE/chain.log)"; exit 1; fi
echo "$(date -Is) chain up (chainId 0xdc388)"

if ! curl -s --max-time 2 -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
  echo "$(date -Is) starting exchange on :$PORT"
  CHAIN_GAS_PRICE="${CHAIN_GAS_PRICE:-2200000000}" setsid nohup node source/nexora-exchange/server.mjs \
    >> "$STATE/exchange.log" 2>&1 < /dev/null &
else
  echo "$(date -Is) exchange already up"
fi
echo "$(date -Is) run.sh done"
