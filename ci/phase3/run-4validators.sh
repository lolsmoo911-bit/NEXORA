#!/usr/bin/env bash
# NEXORA — Phase 3: run 4 independent validators, then test consensus + one-fault
# tolerance + restart recovery.
#
# Ports are offset per node so all four share a single CI runner:
#   node i: p2p 26656+i, rpc 26657+i, json-rpc 8545+i, evm chain id unchanged
#
# Tests performed (each one fails the step loudly):
#   T1  all 4 nodes start from the SAME genesis bytes
#   T2  the 4 validators are present and voting power is equal
#   T3  every node produces blocks and the 4 nodes agree on height + app_hash
#   T4  a Cosmos transfer on the full 4-node network settles
#   T5  kill one validator -> the remaining 3 still produce blocks (quorum)
#   T6  restart the killed validator -> it catches up to the network height
set -euo pipefail

PARAMS_FILE="${PARAMS_FILE:?PARAMS_FILE is required}"
ART="${ARTIFACT_DIR:?ARTIFACT_DIR is required}"
NODES_ROOT="${NODES_ROOT:-/tmp/nexora3}"
VAL_NAMES=(val0 val1 val2 val3)

C_CHAIN_ID="$(jq -r '.cosmos_chain_id' "$PARAMS_FILE")"
E_CHAIN_ID="$(jq -r '.evm_chain_id' "$PARAMS_FILE")"
DENOM="$(jq -r '.denom.base' "$PARAMS_FILE")"
MIN_GAS_PRICE="$(jq -r '.fees.min_gas_price' "$PARAMS_FILE")"
GAS_PRICE="$(jq -r '.fees.gas_price' "$PARAMS_FILE")"
KILL_NODE=3   # the validator stopped during T5

mkdir -p "$ART"
log() { echo "[phase3] $*"; }
rpc_port() { echo $((8545 + $1)); }
tend_port() { echo $((26657 + $1)); }
status_of() {
  evmd status --node "tcp://127.0.0.1:$(tend_port "$1")" -o json 2>/dev/null \
    | jq -r '.sync_info.latest_block_height // "0"'
}

# ---------------- T1: identical genesis bytes across the four homes ----------------
log "=== T1: four nodes, one genesis ==="
REF_SHA=""
for i in 0 1 2 3; do
  H="$NODES_ROOT/node$i"
  [ -d "$H" ] || { log "ERROR: home $H missing (run gen4-genesis.sh first)"; exit 1; }
  S="$(sha256sum "$H/config/genesis.json" | cut -d' ' -f1)"
  log "node$i genesis sha256=$S"
  if [ -z "$REF_SHA" ]; then REF_SHA="$S"; elif [ "$S" != "$REF_SHA" ]; then
    log "ERROR: node$i genesis differs from node0"; exit 1
  fi
done
echo "all four nodes share genesis sha256=$REF_SHA" | tee "$ART/t1-identical-genesis.txt"

# ---------------- T2: validator set declared in the shared genesis ----------------
log "=== T2: validator set declared in the genesis ==="
G0="$NODES_ROOT/node0/config/genesis.json"
NG="$(jq -r '.app_state.genutil.gen_txs | length' "$G0")"
NV="$(jq -r '[.app_state.genutil.gen_txs[].body.messages[0].validator_address] | unique | length' "$G0")"
NM="$(jq -r '[.app_state.genutil.gen_txs[].body.messages[0].description.moniker] | sort | join(",")' "$G0")"
{
  echo "gentxs=$NG"
  echo "distinct_validator_addresses=$NV"
  echo "monikers=$NM"
} | tee "$ART/t2-validators.txt"
[ "$NG" = "4" ] || { log "ERROR: expected 4 gentxs, found $NG"; exit 1; }
[ "$NV" = "4" ] || { log "ERROR: expected 4 distinct validator addresses, found $NV"; exit 1; }
log "T2 OK: 4 distinct validators declared in genesis"

# ---------------- start the four nodes ----------------
log "=== peer wiring (persistent_peers between the four nodes) ==="
declare -a NODEID
for i in 0 1 2 3; do
  NODEID[$i]="$(evmd tendermint show-node-id --home "$NODES_ROOT/node$i" 2>/dev/null)"
  [ -n "${NODEID[$i]}" ] || { log "ERROR: could not read node id for node$i"; exit 1; }
done
for i in 0 1 2 3; do
  PEERS=""
  for j in 0 1 2 3; do
    # `test && cmd` returns 1 when the test is false, which aborts the script under
    # `set -e`; always use the explicit if form here.
    if [ "$i" = "$j" ]; then continue; fi
    if [ -n "$PEERS" ]; then PEERS="$PEERS,"; fi
    PEERS="$PEERS${NODEID[$j]}@127.0.0.1:$((26656 + j))"
  done
  sed -i.bak "s/^persistent_peers = .*/persistent_peers = \"$PEERS\"/" "$NODES_ROOT/node$i/config/config.toml"
  log "node$i peers wired"
done

log "=== starting four validators ==="
for i in 0 1 2 3; do
  H="$NODES_ROOT/node$i"
  JP="$(rpc_port "$i")"
  TP="$(tend_port "$i")"
  PP=$((26656 + i))
  nohup evmd start \
    --home "$H" \
    --chain-id "$C_CHAIN_ID" \
    --minimum-gas-prices "$MIN_GAS_PRICE" \
    --evm.evm-chain-id "$E_CHAIN_ID" \
    --evm.min-tip 0 \
    --pruning nothing \
    --log_level info \
    --p2p.laddr "tcp://0.0.0.0:$PP" \
    --rpc.laddr "tcp://127.0.0.1:$TP" \
    --grpc.address "127.0.0.1:$((9090 + i))" \
    --pprof.address "127.0.0.1:$((6060 + i))" \
    --json-rpc.enable true \
    --json-rpc.address "127.0.0.1:$JP" \
    --json-rpc.api eth,txpool,personal,net,debug,web3 \
    >"$ART/node$i.log" 2>&1 &
  echo $! >"$ART/node$i.pid"
  log "node$i started (json-rpc $JP, comet rpc $TP, p2p $PP)"
done

log "=== wait for consensus ==="
ready=0
for w in $(seq 1 120); do
  H1="$(status_of 0)"; H2="$(status_of 1)"; H3="$(status_of 2)"; H4="$(status_of 3)"
  if [ "$H1" -ge 2 ] 2>/dev/null && [ "$H1" = "$H2" ] && [ "$H2" = "$H3" ] && [ "$H3" = "$H4" ]; then
    ready=1; log "4/4 nodes agree at height $H1 after ${w}s"; break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  log "ERROR: nodes did not converge"
  for i in 0 1 2 3; do echo "--- node$i (height $(status_of $i)) ---"; tail -n 40 "$ART/node$i.log"; done
  exit 1
fi

# ---------------- T3: all nodes agree and advance ----------------
log "=== T3: block production and agreement ==="
declare -a BEFORE
for i in 0 1 2 3; do BEFORE[$i]="$(status_of $i)"; done
sleep 6
: >"$ART/t3-heights.txt"
same=1
for i in 0 1 2 3; do
  now="$(status_of $i)"
  echo "node$i height ${BEFORE[$i]} -> $now" | tee -a "$ART/t3-heights.txt"
  [ "$now" -gt "${BEFORE[$i]}" ] || { log "ERROR: node$i did not advance"; same=0; }
done
REF="$(status_of 0)"
for i in 1 2 3; do
  [ "$(status_of $i)" = "$REF" ] || { log "ERROR: node$i height differs from node0"; same=0; }
done
[ "$same" = 1 ] || exit 1
# identical app hash on every node = identical state
AH0="$(evmd status --node tcp://127.0.0.1:$(tend_port 0) -o json | jq -r '.sync_info.latest_app_hash')"
AH1="$(evmd status --node tcp://127.0.0.1:$(tend_port 1) -o json | jq -r '.sync_info.latest_app_hash')"
AH3="$(evmd status --node tcp://127.0.0.1:$(tend_port 3) -o json | jq -r '.sync_info.latest_app_hash')"
echo "app_hash node0=$AH0 node1=$AH1 node3=$AH3" | tee "$ART/t3-apphash.txt"
[ "$AH0" = "$AH1" ] && [ "$AH1" = "$AH3" ] || { log "ERROR: app hashes differ between nodes"; exit 1; }
log "T3 OK: 4/4 nodes advancing with identical app hashes"

# on-chain validator set (materialised at InitChain from the 4 gentxs)
evmd q staking validators --node "tcp://127.0.0.1:$(tend_port 0)" -o json >"$ART/t2b-validators-onchain.json" 2>/dev/null || true
if [ -s "$ART/t2b-validators-onchain.json" ]; then
  ONV="$(jq -r '.validators | length' "$ART/t2b-validators-onchain.json" 2>/dev/null || echo 0)"
  jq -r '.validators[] | "on-chain validator: \(.description.moniker) status=\(.status) tokens=\(.tokens)"' \
    "$ART/t2b-validators-onchain.json" | tee "$ART/t2b-validators-onchain.txt"
  log "on-chain validator count = $ONV"
fi

# ---------------- T4: transfer over the 4-node network ----------------
log "=== T4: Cosmos transfer on the multi-validator network ==="
N0="$NODES_ROOT/node0"
SRC="$(evmd keys show val0 -a --keyring-backend test --home "$N0")"
DST="$(evmd keys show dev3 -a --keyring-backend test --home "$N0")"
BEFORE_DST="$(evmd q bank balances "$DST" --keyring-backend test --home "$N0" -o json | jq -r ".balances[] | select(.denom==\"$DENOM\") | .amount")"
SEND_OUT="$(evmd tx bank send val0 "$DST" 5550000000000000000"$DENOM" \
  --chain-id "$C_CHAIN_ID" --keyring-backend test --home "$N0" \
  --node "tcp://127.0.0.1:$(tend_port 0)" \
  --gas 300000 --gas-prices "$GAS_PRICE" --broadcast-mode sync -y -o json 2>&1)"
echo "$SEND_OUT" | tee "$ART/t4-send.json"
TXH="$(echo "$SEND_OUT" | jq -r '.txhash // empty')"
[ -n "$TXH" ] || { log "ERROR: no txhash"; exit 1; }
CODE=""
for w in $(seq 1 60); do
  CODE="$(evmd q tx "$TXH" --node "tcp://127.0.0.1:$(tend_port 0)" -o json 2>/dev/null | jq -r '.code // empty' || true)"
  if [ -n "$CODE" ]; then break; fi
  sleep 1
done
echo "tx=$TXH code=$CODE" | tee "$ART/t4-tx-code.txt"
[ "$CODE" = "0" ] || { log "ERROR: transfer failed (code=$CODE)"; exit 1; }
AFTER_DST=""
for w in $(seq 1 30); do
  AFTER_DST="$(evmd q bank balances "$DST" --keyring-backend test --home "$N0" -o json | jq -r ".balances[] | select(.denom==\"$DENOM\") | .amount")"
  python3 -c 'import sys; b,a,d=map(int,sys.argv[1:4]); sys.exit(0 if a==b+d else 1)' "$BEFORE_DST" "$AFTER_DST" 5550000000000000000 && break
  sleep 1
done
echo "dev3 $BEFORE_DST -> $AFTER_DST (+5550000000000000000)" | tee "$ART/t4-balance.txt"
python3 -c 'import sys; b,a,d=map(int,sys.argv[1:4]); sys.exit(0 if a==b+d else 1)' "$BEFORE_DST" "$AFTER_DST" 5550000000000000000 \
  || { log "ERROR: multi-node transfer did not settle"; exit 1; }
log "T4 OK: transfer settled on the 4-validator network"

# ---------------- T5: kill one validator, chain must keep producing ----------------
log "=== T5: one-validator fault tolerance (killing node$KILL_NODE) ==="
PID_K="$(cat "$ART/node$KILL_NODE.pid")"
PRE_KILL="$(status_of 0)"
kill "$PID_K" 2>/dev/null || true
sleep 2
log "node$KILL_NODE (pid $PID_K) stopped"
sleep 8
POST_KILL="$(status_of 0)"
echo "height with 3 validators: $PRE_KILL -> $POST_KILL" | tee "$ART/t5-after-kill.txt"
[ "$POST_KILL" -gt "$PRE_KILL" ] || { log "ERROR: chain halted without node$KILL_NODE"; exit 1; }
# a transfer must still work with 3/4 validators
evmd q bank balances "$DST" --keyring-backend test --home "$N0" -o json >"$ART/t5-query-during-fault.json"
log "T5 OK: chain produced $((POST_KILL - PRE_KILL)) blocks and kept serving queries with 3/4 validators"

# ---------------- T6: restart the stopped validator and let it catch up ----------------
log "=== T6: recovery of node$KILL_NODE ==="
H="$NODES_ROOT/node$KILL_NODE"
nohup evmd start \
  --home "$H" \
  --chain-id "$C_CHAIN_ID" \
  --minimum-gas-prices "$MIN_GAS_PRICE" \
  --evm.evm-chain-id "$E_CHAIN_ID" \
  --evm.min-tip 0 \
  --pruning nothing \
  --log_level info \
  --p2p.laddr "tcp://0.0.0.0:$((26656 + KILL_NODE))" \
  --rpc.laddr "tcp://127.0.0.1:$(tend_port $KILL_NODE)" \
  --grpc.address "127.0.0.1:$((9090 + KILL_NODE))" \
  --pprof.address "127.0.0.1:$((6060 + KILL_NODE))" \
  --json-rpc.enable true \
  --json-rpc.address "127.0.0.1:$(rpc_port $KILL_NODE)" \
  --json-rpc.api eth,txpool,personal,net,debug,web3 \
  >>"$ART/node$KILL_NODE.log" 2>&1 &
echo $! >"$ART/node$KILL_NODE.pid"
log "node$KILL_NODE restarted, waiting for catch-up"

caught=0
for w in $(seq 1 120); do
  HN="$(status_of $KILL_NODE)"
  H0="$(status_of 0)"
  if [ -n "$HN" ] && [ "$HN" -ge "$H0" ] 2>/dev/null; then
    caught=1; echo "node$KILL_NODE caught up: height $HN (network $H0) after ${w}s" | tee "$ART/t6-recovery.txt"; break
  fi
  sleep 1
done
[ "$caught" = 1 ] || { log "ERROR: node$KILL_NODE did not catch up"; tail -n 60 "$ART/node$KILL_NODE.log"; exit 1; }
log "T6 OK: recovered validator re-synced to the network tip"

log "=== DONE: Phase 3 multi-validator devnet verified (consensus, 1-fault tolerance, recovery) ==="
