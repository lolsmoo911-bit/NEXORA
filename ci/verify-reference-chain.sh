#!/usr/bin/env bash
# NEXORA — Phase 1 verification of the UNMODIFIED cosmos/evm reference chain.
#
# Scope (per owner): build + run the original reference, verify JSON-RPC, deploy
# a simple Solidity contract. NO NEXORA customization, NO consensus/dependency
# changes, NO production keys, NO mainnet, NO paid resources.
#
# What it does:
#   1. starts the pinned evmd local node via upstream `local_node.sh -y --no-install`
#   2. verifies JSON-RPC: eth_chainId, net_version, web3_clientVersion,
#      and that eth_blockNumber advances
#   3. deploys contracts/src/NexoraGreeter.sol from the genesis-funded dev0
#      account and reads it back
#
# Requires on PATH: evmd (built from the pinned commit), jq, curl, forge, cast.
#
# Environment overrides:
#   COSMOS_EVM_DIR  path to the checked-out reference repo (default /tmp/cosmos-evm)
#   CHAIN_ID        Cosmos chain id passed to local_node.sh (default cosmos_262144-1)
#   REPO_ROOT       path to this NEXORA repo (default: script's parent dir)
#   ARTIFACT_DIR    where transcripts are written (default $REPO_ROOT/ci-artifacts)
set -euo pipefail

COSMOS_EVM_DIR="${COSMOS_EVM_DIR:-/tmp/cosmos-evm}"
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ART="${ARTIFACT_DIR:-$REPO_ROOT/ci-artifacts}"
RPC="${RPC_URL:-http://127.0.0.1:8545}"
COSMOS_CHAIN_ID="${CHAIN_ID:-cosmos_262144-1}"
EXPECTED_EVM_CHAIN_ID="0x40000"   # server/config/config.go: DefaultEVMChainID = 262144
HOME_EVMD="$HOME/.evmd"

mkdir -p "$ART"
log() { echo "[phase1] $*"; }
rpc() { # method [params-json]
  curl -s -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC"
}

log "=== toolchain ==="
evmd version | tee "$ART/evmd-version.txt"
forge --version | tee "$ART/forge-version.txt"
jq --version | tee "$ART/jq-version.txt"

log "=== start node (upstream local_node.sh, unmodified) ==="
cd "$COSMOS_EVM_DIR"
nohup env CHAIN_ID="$COSMOS_CHAIN_ID" ./local_node.sh -y --no-install >"$ART/node.log" 2>&1 &
NODE_PID=$!
echo "$NODE_PID" >"$ART/node.pid"
log "node pid=$NODE_PID (chain-id=$COSMOS_CHAIN_ID)"

log "=== wait for JSON-RPC on $RPC ==="
up=0
for i in $(seq 1 180); do
  if rpc eth_chainId | grep -q '"result"'; then up=1; log "JSON-RPC up after ${i}s"; break; fi
  if ! kill -0 "$NODE_PID" 2>/dev/null; then log "node process exited early"; break; fi
  sleep 1
done
if [ "$up" != 1 ]; then
  log "ERROR: JSON-RPC did not come up"
  tail -n 80 "$ART/node.log"
  exit 1
fi

log "=== JSON-RPC checks ==="
rpc eth_chainId | tee "$ART/eth_chainId.json"; echo
rpc net_version | tee "$ART/net_version.json"; echo
rpc web3_clientVersion | tee "$ART/web3_clientVersion.json"; echo
# sample eth_blockNumber until non-null (block 0 may not be finalized yet)
BN1=""
for i in $(seq 1 30); do
  BN1="$(rpc eth_blockNumber | jq -r '.result // empty')"
  [ -n "$BN1" ] && { echo "$BN1" | tee "$ART/eth_blockNumber-1.json"; echo; break; }
  sleep 1
done
sleep 3
BN2="$(rpc eth_blockNumber | jq -r '.result // empty')"
echo "$BN2" | tee "$ART/eth_blockNumber-2.json"; echo

CHAIN_ID_RESULT="$(jq -r '.result' "$ART/eth_chainId.json")"
if [ "$CHAIN_ID_RESULT" != "$EXPECTED_EVM_CHAIN_ID" ]; then
  log "ERROR: eth_chainId=$CHAIN_ID_RESULT expected $EXPECTED_EVM_CHAIN_ID"
  exit 1
fi
[ -n "$BN1" ] || { log "ERROR: eth_blockNumber stayed null"; exit 1; }
[ -n "$BN2" ] || { log "ERROR: eth_blockNumber null after wait"; exit 1; }
if ! jq -ne --arg a "${BN1#0x}" --arg b "${BN2#0x}" '($a|tonumber) < ($b|tonumber)'; then
  log "ERROR: blockNumber did not advance ($BN1 -> $BN2)"
  exit 1
fi
log "eth_chainId OK ($CHAIN_ID_RESULT)"
log "net_version: $(jq -r '.result' "$ART/net_version.json")"
log "blockNumber (t0): $BN1"
log "blockNumber (t+3s): $BN2"
log "blockNumber advancing OK ($BN1 -> $BN2)"

log "=== dev0 account + balance (genesis-funded) ==="
DEV0_ADDR="$(evmd keys show dev0 -a --keyring-backend test --home "$HOME_EVMD")"
echo "dev0=$DEV0_ADDR" | tee "$ART/dev0-address.txt"
evmd q bank balances "$DEV0_ADDR" --keyring-backend test --home "$HOME_EVMD" -o json | tee "$ART/dev0-balances.json"; echo
DEV0_PK="0x$(evmd keys unsafe-export-eth-key dev0 --keyring-backend test --home "$HOME_EVMD" | tr -d '\r\n' | tr 'A-F' 'a-f')"
DEV0_EVM="$(cast wallet address --private-key "$DEV0_PK" | tr 'A-F' 'a-f')"
rpc eth_getBalance "[\"$DEV0_EVM\",\"latest\"]" | tee "$ART/dev0-evm-balance.json"; echo

log "=== compile + deploy Solidity contract ==="
cd "$REPO_ROOT/contracts"
forge build 2>&1 | tee "$ART/forge-build.log"

set +e
# NOTE: --constructor-args must be the LAST flag. forge eats every token that
# follows it as constructor args (1st CI run proved it: "expected 1 but got 7").
DEPLOY_OUT="$(forge create src/NexoraGreeter.sol:NexoraGreeter \
  --rpc-url "$RPC" --private-key "$DEV0_PK" --broadcast \
  --constructor-args "Hello NEXORA" 2>&1)"
RC=$?
if [ $RC -ne 0 ]; then
  log "first deploy attempt failed (rc=$RC); retrying with --legacy"
  DEPLOY_OUT="$(forge create src/NexoraGreeter.sol:NexoraGreeter \
    --rpc-url "$RPC" --private-key "$DEV0_PK" --broadcast --legacy \
    --constructor-args "Hello NEXORA" 2>&1)"
  RC=$?
fi
set -e
echo "$DEPLOY_OUT" | tee "$ART/deploy.log"
if [ $RC -ne 0 ]; then log "ERROR: contract deploy failed"; exit 1; fi

CONTRACT="$(echo "$DEPLOY_OUT" | sed -n 's/^Deployed to: //p' | tr -d ' \r')"
echo "contract=$CONTRACT" | tee "$ART/contract-address.txt"
[ -n "$CONTRACT" ] || { log "ERROR: could not parse contract address"; exit 1; }

log "=== read contract state back ==="
cast call "$CONTRACT" "greet()(string)" --rpc-url "$RPC" | tee "$ART/greet.txt"; echo
cast code "$CONTRACT" --rpc-url "$RPC" | head -c 82 | tee "$ART/contract-code.txt"; echo

log "=== DONE: reference chain verified (JSON-RPC + Solidity deploy) ==="
