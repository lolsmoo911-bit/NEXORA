#!/usr/bin/env bash
# NEXORA — Phase 2 devnet verification (starts the NEXORA devnet node and checks it).
#
# Checks (all fail loudly):
#   1. node starts and produces blocks on cosmos chain-id  nexora-devnet-1
#   2. JSON-RPC: eth_chainId / net_version == the NEXORA EVM chain id (not 262144)
#   3. on-chain denom == anex with 18-decimal bank metadata (EVM coin info)
#   4. a bank transfer (anex) settles and balances move exactly
#   5. an EVM transfer (wei of anex) settles exactly
#   6. a Solidity contract deploys and greet() is callable
#
# NOTE on big integers: genesis balances are ~1e21 base units, which exceeds the
# exact integer range of both jq (IEEE-754 doubles) and bash arithmetic, so all
# numeric assertions are done with python3 (arbitrary precision).
#
# Env: PARAMS_FILE, NEXORA_HOME, ARTIFACT_DIR, RPC_URL
set -euo pipefail

PARAMS_FILE="${PARAMS_FILE:?PARAMS_FILE is required}"
NEXORA_HOME="${NEXORA_HOME:?NEXORA_HOME is required}"
ART="${ARTIFACT_DIR:?ARTIFACT_DIR is required}"
KEYRING="${KEYRING:-test}"

C_CHAIN_ID="$(jq -r '.cosmos_chain_id' "$PARAMS_FILE")"
E_CHAIN_ID="$(jq -r '.evm_chain_id' "$PARAMS_FILE")"
DENOM="$(jq -r '.denom.base' "$PARAMS_FILE")"
DISPLAY="$(jq -r '.denom.display' "$PARAMS_FILE")"
GAS_PRICE="$(jq -r '.fees.gas_price' "$PARAMS_FILE")"
MIN_GAS_PRICE="$(jq -r '.fees.min_gas_price' "$PARAMS_FILE")"
DEV0="$(jq -r '.accounts.names[0]' "$PARAMS_FILE")"
DEV1="$(jq -r '.accounts.names[1]' "$PARAMS_FILE")"
RPC="${RPC_URL:-http://127.0.0.1:8545}"
E_CHAIN_ID_HEX="$(printf '0x%x' "$E_CHAIN_ID")"
TRANSFER_AMOUNT="1230000000000000000"   # 1.23 NEX
EVM_TRANSFER_WEI="100000000000000000"  # 0.1 NEX

mkdir -p "$ART"
log() { echo "[phase2-verify] $*"; }
rpc() { curl -s -H 'Content-Type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC"; }

log "=== expected identity ==="
echo "cosmos chain-id=$C_CHAIN_ID  evm chain-id=$E_CHAIN_ID ($E_CHAIN_ID_HEX)  denom=$DENOM display=$DISPLAY" | tee "$ART/expected-identity.txt"

# ---------- start node ----------
log "=== start NEXORA devnet node ==="
nohup evmd start \
  --home "$NEXORA_HOME" \
  --chain-id "$C_CHAIN_ID" \
  --minimum-gas-prices "$MIN_GAS_PRICE" \
  --evm.evm-chain-id "$E_CHAIN_ID" \
  --evm.min-tip 0 \
  --pruning nothing \
  --log_level info \
  --json-rpc.enable true \
  --json-rpc.address 127.0.0.1:8545 \
  --json-rpc.api eth,txpool,personal,net,debug,web3 \
  >"$ART/node.log" 2>&1 &
NODE_PID=$!
echo "$NODE_PID" >"$ART/node.pid"
log "node pid=$NODE_PID"

log "=== wait for JSON-RPC on $RPC ==="
up=0
for i in $(seq 1 120); do
  if rpc eth_chainId | grep -q '"result"'; then up=1; log "JSON-RPC up after ${i}s"; break; fi
  if ! kill -0 "$NODE_PID" 2>/dev/null; then log "node exited early"; break; fi
  sleep 1
done
if [ "$up" != 1 ]; then
  log "ERROR: JSON-RPC did not come up"; tail -n 120 "$ART/node.log"; exit 1
fi

log "=== identity checks ==="
NET="$(evmd status --node tcp://127.0.0.1:26657 -o json | jq -r '.node_info.network')"
echo "node network: $NET" | tee "$ART/node-network.txt"
[ "$NET" = "$C_CHAIN_ID" ] || { log "ERROR: cosmos chain-id is '$NET', expected '$C_CHAIN_ID'"; exit 1; }

CHAIN_HEX="$(rpc eth_chainId | jq -r '.result')"
NETVER="$(rpc net_version | jq -r '.result')"
echo "eth_chainId: $CHAIN_HEX" | tee "$ART/eth_chainId.txt"
echo "net_version: $NETVER" | tee "$ART/net_version.txt"
[ "$CHAIN_HEX" = "$E_CHAIN_ID_HEX" ] || { log "ERROR: eth_chainId=$CHAIN_HEX expected $E_CHAIN_ID_HEX"; exit 1; }
[ "$NETVER" = "$E_CHAIN_ID" ] || { log "ERROR: net_version=$NETVER expected $E_CHAIN_ID"; exit 1; }
[ "$CHAIN_HEX" != "0x40000" ] || { log "ERROR: chain id is still the upstream reference value"; exit 1; }
log "chain identity OK (cosmos=$C_CHAIN_ID, evm=$E_CHAIN_ID)"

BN1=""; for i in $(seq 1 30); do BN1="$(rpc eth_blockNumber | jq -r '.result // empty')"; [ -n "$BN1" ] && break; sleep 1; done
sleep 3
BN2="$(rpc eth_blockNumber | jq -r '.result // empty')"
echo "blockNumber t0=$BN1 t+3s=$BN2" | tee "$ART/blocknumber.txt"
python3 -c 'import sys; a=int(sys.argv[1],16); b=int(sys.argv[2],16); sys.exit(0 if b>a else 1)' "${BN1#0x}" "${BN2#0x}" \
  || { log "ERROR: blockNumber did not advance ($BN1 -> $BN2)"; exit 1; }

log "=== on-chain denom checks (anex, 18 decimals) ==="
EVM_DENOM="$(evmd q evm params -o json | jq -r '.params.evm_denom')"
BOND_DENOM="$(evmd q staking params -o json | jq -r '.params.bond_denom')"
MINT_DENOM="$(evmd q mint params -o json | jq -r '.params.mint_denom')"
META="$(jq -r '.app_state.bank.denom_metadata[0] as $m | "base=\($m.base) display=\($m.display) exp=\([$m.denom_units[] | select(.denom == $m.display) | .exponent][0]) symbol=\($m.symbol)"' "$NEXORA_HOME/config/genesis.json")"
{ echo "evm_denom=$EVM_DENOM"; echo "bond_denom=$BOND_DENOM"; echo "mint_denom=$MINT_DENOM"; echo "bank_metadata=$META"; } | tee "$ART/denom-checks.txt"
for d in "$EVM_DENOM" "$BOND_DENOM" "$MINT_DENOM"; do
  [ "$d" = "$DENOM" ] || { log "ERROR: on-chain denom '$d' != $DENOM"; exit 1; }
done
echo "$META" | grep -q 'exp=18' || { log "ERROR: display denom exponent is not 18 ($META)"; exit 1; }
log "denom consistency OK (anex, 18 decimals)"

log "=== fees (feemarket base fee vs configured gas price) ==="
GASPRICE_HEX="$(rpc eth_gasPrice | jq -r '.result')"
GASPRICE_DEC="$(python3 -c 'import sys; print(int(sys.argv[1],16))' "${GASPRICE_HEX:-0x0}")"
CFG_DEC="${GAS_PRICE%$DENOM}"
{
  echo "node_eth_gasPrice=$GASPRICE_HEX ($GASPRICE_DEC $DENOM/gas)"
  echo "configured_gas_price=$GAS_PRICE ($CFG_DEC $DENOM/gas)"
  echo "min_gas_price_floor=$MIN_GAS_PRICE"
} | tee "$ART/fees.txt"
python3 -c 'import sys; sys.exit(0 if int(sys.argv[2]) >= int(sys.argv[1]) else 1)' "$GASPRICE_DEC" "$CFG_DEC" \
  || { log "ERROR: configured gas price $CFG_DEC is below the node base fee $GASPRICE_DEC"; exit 1; }
log "configured gas price clears the feemarket base fee"

log "=== accounts ==="
DEV0_COSMOS="$(evmd keys show "$DEV0" -a --keyring-backend "$KEYRING" --home "$NEXORA_HOME")"
DEV1_COSMOS="$(evmd keys show "$DEV1" -a --keyring-backend "$KEYRING" --home "$NEXORA_HOME")"
DEV0_PK="0x$(evmd keys unsafe-export-eth-key "$DEV0" --keyring-backend "$KEYRING" --home "$NEXORA_HOME" | tr -d '\r\n' | tr 'A-F' 'a-f')"
DEV1_PK="0x$(evmd keys unsafe-export-eth-key "$DEV1" --keyring-backend "$KEYRING" --home "$NEXORA_HOME" | tr -d '\r\n' | tr 'A-F' 'a-f')"
DEV0_EVM="$(cast wallet address --private-key "$DEV0_PK" | tr 'A-F' 'a-f')"
DEV1_EVM="$(cast wallet address --private-key "$DEV1_PK" | tr 'A-F' 'a-f')"
echo "cosmos: $DEV0=$DEV0_COSMOS  $DEV1=$DEV1_COSMOS" | tee "$ART/accounts-cosmos.txt"
echo "evm:    $DEV0=$DEV0_EVM  $DEV1=$DEV1_EVM" | tee "$ART/accounts-evm.txt"
evmd q bank balances "$DEV0_COSMOS" --keyring-backend "$KEYRING" --home "$NEXORA_HOME" -o json | tee "$ART/dev0-balances-before.json"; echo

bal_of() { evmd q bank balances "$1" --keyring-backend "$KEYRING" --home "$NEXORA_HOME" -o json | jq -r ".balances[] | select(.denom==\"$DENOM\") | .amount"; }
BEFORE0="$(bal_of "$DEV0_COSMOS")"; BEFORE1="$(bal_of "$DEV1_COSMOS")"

log "=== bank transfer ($TRANSFER_AMOUNT$DENOM) ==="
SEND_OUT="$(evmd tx bank send "$DEV0" "$DEV1_COSMOS" "$TRANSFER_AMOUNT$DENOM" \
  --chain-id "$C_CHAIN_ID" --keyring-backend "$KEYRING" --home "$NEXORA_HOME" \
  --gas 300000 --gas-prices "$GAS_PRICE" --broadcast-mode sync -y -o json 2>&1)"
echo "$SEND_OUT" | tee "$ART/bank-send.json"
TXHASH="$(echo "$SEND_OUT" | jq -r '.txhash // .tx_response.txhash // empty' 2>/dev/null || true)"
[ -n "$TXHASH" ] || { log "ERROR: no txhash in the bank send response"; exit 1; }
echo "bank tx hash: $TXHASH" | tee "$ART/bank-tx-hash.txt"

# wait for inclusion and success
TXCODE=""
for i in $(seq 1 60); do
  TXCODE="$(evmd q tx "$TXHASH" -o json 2>/dev/null | jq -r '.code // empty' || true)"
  [ -n "$TXCODE" ] && break
  sleep 1
done
echo "bank tx code: $TXCODE" | tee "$ART/bank-tx-code.txt"
[ "$TXCODE" = "0" ] || {
  log "ERROR: bank transfer tx failed (code=$TXCODE)"
  evmd q tx "$TXHASH" -o json 2>/dev/null | jq -r '.raw_log' | tail -n 20 | tee "$ART/bank-tx-rawlog.txt" || true
  exit 1
}

# balances settle a block or two after inclusion
AFTER0=""; AFTER1=""
for i in $(seq 1 30); do
  AFTER0="$(bal_of "$DEV0_COSMOS")"; AFTER1="$(bal_of "$DEV1_COSMOS")"
  if python3 -c 'import sys; before,after,add=map(int,sys.argv[1:4]); sys.exit(0 if after==before+add else 1)' "$BEFORE1" "$AFTER1" "$TRANSFER_AMOUNT"; then
    break
  fi
  sleep 1
done
echo "dev0: $BEFORE0 -> $AFTER0" | tee "$ART/bank-transfer-result.txt"
echo "dev1: $BEFORE1 -> $AFTER1 (expected +$TRANSFER_AMOUNT)" | tee -a "$ART/bank-transfer-result.txt"
python3 -c 'import sys; before,after,add=map(int,sys.argv[1:4]); sys.exit(0 if after==before+add else 1)' \
  "$BEFORE1" "$AFTER1" "$TRANSFER_AMOUNT" \
  || { log "ERROR: dev1 balance is not before+$TRANSFER_AMOUNT"; exit 1; }
log "bank transfer OK"

log "=== EVM transfer ($EVM_TRANSFER_WEI wei of $DENOM) ==="
E0_B="$(rpc eth_getBalance "[\"$DEV0_EVM\",\"latest\"]" | jq -r '.result')"
E1_B="$(rpc eth_getBalance "[\"$DEV1_EVM\",\"latest\"]" | jq -r '.result')"
if ! EV_OUT="$(cast send "$DEV1_EVM" "$EVM_TRANSFER_WEI" --rpc-url "$RPC" --private-key "$DEV0_PK" --legacy 2>&1)"; then
  EV_OUT="$(cast send "$DEV1_EVM" "$EVM_TRANSFER_WEI" --rpc-url "$RPC" --private-key "$DEV0_PK" --broadcast --legacy 2>&1)"
fi
echo "$EV_OUT" | tee "$ART/evm-send.log"
E1_A=""
for i in $(seq 1 30); do
  E1_A="$(rpc eth_getBalance "[\"$DEV1_EVM\",\"latest\"]" | jq -r '.result')"
  if python3 -c 'import sys; before,after,add=(int(x,16) if i<2 else int(x) for i,x in enumerate(sys.argv[1:4])); sys.exit(0 if after==before+add else 1)' "$E1_B" "$E1_A" "$EVM_TRANSFER_WEI"; then
    break
  fi
  sleep 1
done
echo "dev0 evm balance: $E0_B" | tee "$ART/evm-transfer-result.txt"
echo "dev1 evm balance: $E1_B -> $E1_A (expected +$EVM_TRANSFER_WEI)" | tee -a "$ART/evm-transfer-result.txt"

# --- diagnostics: is the value actually in the state at the mined block? ---
TXHEX="$(printf '%s\n' "$EV_OUT" | grep -oE '0x[0-9a-f]{64}' | head -1 || true)"
{
  echo "--- tx object (eth_getTransactionByHash) ---"
  echo "parsed_hash=$TXHEX"
  rpc eth_getTransactionByHash "[\"$TXHEX\"]" | jq '{hash, value, to, blockNumber, type, gas, gasPrice}' 2>/dev/null || true
  echo "--- dev1 balance by block tag ---"
  for tag in latest 0x8 0x9 0xa; do
    printf '%s = %s\n' "$tag" "$(rpc eth_getBalance "[\"$DEV1_EVM\",\"$tag\"]" | jq -r '.result // "n/a"')"
  done
  echo "--- dev0 balance latest ---"
  rpc eth_getBalance "[\"$DEV0_EVM\",\"latest\"]" | jq -r '.result'
  echo "--- current head ---"
  rpc eth_blockNumber | jq -r '.result'
  echo "--- Cosmos bank view of the same 20-byte addresses ---"
  evmd q bank balances "$DEV1_EVM" --keyring-backend "$KEYRING" --home "$NEXORA_HOME" -o json 2>/dev/null || true
  evmd q bank balances "$DEV0_EVM" --keyring-backend "$KEYRING" --home "$NEXORA_HOME" -o json 2>/dev/null || true
} | tee "$ART/evm-transfer-diagnostics.txt"

# second attempt using an explicit --value flag
if ! python3 -c 'import sys; before,after,add=(int(x,16) if i<2 else int(x) for i,x in enumerate(sys.argv[1:4])); sys.exit(0 if after==before+add else 1)' \
      "$E1_B" "$E1_A" "$EVM_TRANSFER_WEI"; then
  log "first EVM send did not move value; retrying with an explicit --value flag"
  EV_OUT2="$(cast send "$DEV1_EVM" --value "$EVM_TRANSFER_WEI" --rpc-url "$RPC" --private-key "$DEV0_PK" --legacy 2>&1)"
  echo "$EV_OUT2" | tee "$ART/evm-send-2.log"
  TXHEX2="$(printf '%s\n' "$EV_OUT2" | grep -oE '0x[0-9a-f]{64}' | head -1 || true)"
  rpc eth_getTransactionByHash "[\"$TXHEX2\"]" | jq '{hash, value, to, blockNumber}' 2>/dev/null | tee "$ART/evm-send-2-tx.json" || true
  for i in $(seq 1 30); do
    E1_A="$(rpc eth_getBalance "[\"$DEV1_EVM\",\"latest\"]" | jq -r '.result')"
    if python3 -c 'import sys; before,after,add=(int(x,16) if i<2 else int(x) for i,x in enumerate(sys.argv[1:4])); sys.exit(0 if after==before+add else 1)' "$E1_B" "$E1_A" "$EVM_TRANSFER_WEI"; then
      break
    fi
    sleep 1
  done
  echo "dev1 evm balance after explicit --value retry: $E1_B -> $E1_A" | tee -a "$ART/evm-transfer-result.txt"
fi

python3 -c 'import sys; before,after,add=(int(x,16) if i<2 else int(x) for i,x in enumerate(sys.argv[1:4])); sys.exit(0 if after==before+add else 1)' \
  "$E1_B" "$E1_A" "$EVM_TRANSFER_WEI" \
  || { log "ERROR: EVM value transfer did not move the bank balance (see evm-transfer-diagnostics.txt)"; exit 1; }
log "EVM transfer OK"

log "=== Solidity deploy + call ==="
forge build 2>&1 | tee "$ART/forge-build.log"
# --constructor-args must stay the LAST flag (forge consumes trailing tokens as ctor args).
# Prefer a typed (EIP-1559) deploy; fall back to --legacy, then to a no-explicit-chain-id variant.
set +e
DEPLOY_OUT="$(forge create src/NexoraGreeter.sol:NexoraGreeter \
  --rpc-url "$RPC" --private-key "$DEV0_PK" --broadcast --chain-id "$E_CHAIN_ID" \
  --constructor-args "Hello NEXORA" 2>&1)"
RC=$?
if [ $RC -ne 0 ]; then
  log "typed deploy failed (rc=$RC); retrying with --legacy"
  DEPLOY_OUT="$(forge create src/NexoraGreeter.sol:NexoraGreeter \
    --rpc-url "$RPC" --private-key "$DEV0_PK" --broadcast --legacy --chain-id "$E_CHAIN_ID" \
    --constructor-args "Hello NEXORA" 2>&1)"
  RC=$?
fi
if [ $RC -ne 0 ]; then
  log "legacy deploy failed (rc=$RC); retrying without an explicit --chain-id"
  DEPLOY_OUT="$(forge create src/NexoraGreeter.sol:NexoraGreeter \
    --rpc-url "$RPC" --private-key "$DEV0_PK" --broadcast --legacy \
    --constructor-args "Hello NEXORA" 2>&1)"
  RC=$?
fi
set -e
echo "$DEPLOY_OUT" | tee "$ART/deploy.log"
[ "$RC" -eq 0 ] || { log "ERROR: contract deploy failed after all attempts"; exit 1; }
CONTRACT="$(echo "$DEPLOY_OUT" | sed -n 's/^Deployed to: //p' | tr -d ' \r')"
[ -n "$CONTRACT" ] || { log "ERROR: could not parse deployed contract address"; exit 1; }
echo "contract=$CONTRACT" | tee "$ART/contract-address.txt"

GREET="$(cast call "$CONTRACT" 'greet()(string)' --rpc-url "$RPC")"
echo "$GREET" | tee "$ART/greet.txt"
[ "$GREET" = '"Hello NEXORA"' ] || { log "ERROR: unexpected greet() output: $GREET"; exit 1; }
cast code "$CONTRACT" --rpc-url "$RPC" | head -c 82 | tee "$ART/contract-code.txt"; echo

log "=== DONE: NEXORA devnet verified (chain ids + anex/18dec + transfers + Solidity) ==="
