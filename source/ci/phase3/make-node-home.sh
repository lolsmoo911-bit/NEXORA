#!/usr/bin/env bash
# NEXORA — Phase 3: provision one node home from the SHARED genesis.
#
# Each validator needs:
#   - the identical shared genesis bytes (byte-for-byte, so the chain hash matches)
#   - its OWN priv_validator_key.json, derived from its own upstream test mnemonic,
#     so its consensus pubkey matches the create-validator tx in the shared genesis
#   - its own keyring entry
#
# `evmd init` regenerates the genesis, so the shared file is copied back afterwards.
#
# Usage: make-node-home.sh <index 0-3> <shared_genesis> <target_home> <template_home>
set -euo pipefail

IDX="${1:?validator index required}"
GENESIS_SRC="${2:?shared genesis required}"
HOME_DIR="${3:?target home required}"
TEMPLATE_HOME="${4:?template home required}"
COSMOS_EVM_DIR="${COSMOS_EVM_DIR:-/tmp/cosmos-evm}"
PARAMS_FILE="${PARAMS_FILE:?PARAMS_FILE is required}"
KEYRING="test"
KEYALGO="eth_secp256k1"
VAL_NAMES=(val0 val1 val2 val3)

log() { echo "[phase3-node$IDX] $*"; }
LOCAL_NODE="$COSMOS_EVM_DIR/local_node.sh"
C_CHAIN_ID="$(jq -r '.cosmos_chain_id' "$PARAMS_FILE")"

VAL_MNEMONIC="$(sed -n 's/^[[:space:]]*VAL_MNEMONIC="\(.*\)"[[:space:]]*$/\1/p' "$LOCAL_NODE" | head -n1)"
mapfile -t DEV_MNEMONICS < <(
  awk '/default_mnemonics=\(/{f=1;next} f&&/^[[:space:]]*\)/{exit} f{print}' "$LOCAL_NODE" \
    | grep -oE '"[^"]+"' | tr -d '"'
)
[ "${#DEV_MNEMONICS[@]}" -ge 3 ] || { log "upstream mnemonics missing"; exit 1; }
ALL=("$VAL_MNEMONIC" "${DEV_MNEMONICS[0]}" "${DEV_MNEMONICS[1]}" "${DEV_MNEMONICS[2]}")
M="${ALL[$IDX]}"

rm -rf "$HOME_DIR"; mkdir -p "$HOME_DIR"
# the client config must be valid BEFORE init (init refuses an empty chain-id)
evmd config set client chain-id "$C_CHAIN_ID" --home "$HOME_DIR"
evmd config set client keyring-backend "$KEYRING" --home "$HOME_DIR"
# init with this validator's mnemonic -> correct priv_validator_key.json
echo "$M" | evmd init "nexora-node-$IDX" -o --chain-id "$C_CHAIN_ID" --home "$HOME_DIR" --recover >/dev/null
echo "$M" | evmd keys add "${VAL_NAMES[$IDX]}" --recover --keyring-backend "$KEYRING" --algo "$KEYALGO" --home "$HOME_DIR" >/dev/null
# dev3 (plain funded account) lives in the shared genesis; add its key here too
echo "${DEV_MNEMONICS[3]}" | evmd keys add dev3 --recover --keyring-backend "$KEYRING" --algo "$KEYALGO" --home "$HOME_DIR" >/dev/null

# adopt the tuned config (timeouts, mempool type, evm chain id, rpc enabled) from the template
cp "$TEMPLATE_HOME/config/config.toml" "$HOME_DIR/config/config.toml"
cp "$TEMPLATE_HOME/config/app.toml" "$HOME_DIR/config/app.toml"
# and the SHARED genesis bytes
cp "$GENESIS_SRC" "$HOME_DIR/config/genesis.json"
rm -rf "$HOME_DIR/config/gentx"

SHA="$(sha256sum "$HOME_DIR/config/genesis.json" | cut -d' ' -f1)"
VP="$(evmd keys show "${VAL_NAMES[$IDX]}" --bech val -a --keyring-backend "$KEYRING" --home "$HOME_DIR")"
NODEID="$(evmd tendermint show-node-id --home "$HOME_DIR" 2>/dev/null || echo unknown)"
{
  echo "node=$IDX home=$HOME_DIR"
  echo "genesis_sha256=$SHA"
  echo "validator=${VAL_NAMES[$IDX]} valoper=$VP"
  echo "p2p_node_id=$NODEID"
} | tee "$HOME_DIR/node-identity.txt"
log "provisioned (genesis $SHA, valoper $VP)"
