#!/usr/bin/env bash
# NEXORA — Phase 2 deterministic genesis generation (config only, reversible).
#
# Scope guarantees:
#   - The upstream reference repo (cosmos/evm @ v0.7.3) is NEVER modified.
#   - Only a fresh evmd home directory (config/genesis data) is produced.
#   - No key material is stored in this repo: dev/validator mnemonics are parsed
#     at runtime from the upstream, unmodified local_node.sh.
#   - Output is deterministic: running this script twice produces a byte-identical
#     genesis.json (genesis_time is pinned, keys come from fixed upstream mnemonics).
#
# Env:
#   PARAMS_FILE    path to chain/nexora-devnet.json (required)
#   COSMOS_EVM_DIR upstream clone (default /tmp/cosmos-evm)
#   NEXORA_HOME    target evmd home to create (required)
#   KEYRING        default: test
set -euo pipefail

PARAMS_FILE="${PARAMS_FILE:?PARAMS_FILE is required}"
NEXORA_HOME="${NEXORA_HOME:?NEXORA_HOME is required}"
COSMOS_EVM_DIR="${COSMOS_EVM_DIR:-/tmp/cosmos-evm}"
KEYRING="${KEYRING:-test}"
KEYALGO="eth_secp256k1"
MONIKER_NAME="nexora-devnet-node"
LOGLEVEL="info"
BASEFEE="10000000"

log() { echo "[phase2-genesis] $*"; }

command -v jq >/dev/null 2>&1 || { log "jq is required"; exit 1; }
command -v evmd >/dev/null 2>&1 || { log "evmd is required"; exit 1; }
LOCAL_NODE="$COSMOS_EVM_DIR/local_node.sh"
[ -f "$LOCAL_NODE" ] || { log "upstream local_node.sh not found at $LOCAL_NODE"; exit 1; }

# ---------- load parameters ----------
C_CHAIN_ID="$(jq -r '.cosmos_chain_id' "$PARAMS_FILE")"
E_CHAIN_ID="$(jq -r '.evm_chain_id' "$PARAMS_FILE")"
DENOM="$(jq -r '.denom.base' "$PARAMS_FILE")"
DISPLAY="$(jq -r '.denom.display' "$PARAMS_FILE")"
DECIMALS="$(jq -r '.denom.exponent' "$PARAMS_FILE")"
SYMBOL="$(jq -r '.denom.symbol' "$PARAMS_FILE")"
DNAME="$(jq -r '.denom.name' "$PARAMS_FILE")"
DDESC="$(jq -r '.denom.description' "$PARAMS_FILE")"
MIN_GAS_PRICE="$(jq -r '.fees.min_gas_price' "$PARAMS_FILE")"
GAS_PRICE="$(jq -r '.fees.gas_price' "$PARAMS_FILE")"
MAX_GAS="$(jq -r '.consensus.block_max_gas' "$PARAMS_FILE")"
VAL_BAL="$(jq -r '.accounts.validator_balance' "$PARAMS_FILE")"
DEV_BAL="$(jq -r '.accounts.dev_balance' "$PARAMS_FILE")"
DEV_NAMES=($(jq -r '.accounts.names[]' "$PARAMS_FILE"))
VAL_NAME="$(jq -r '.accounts.validator' "$PARAMS_FILE")"
GENESIS_TIME="$(jq -r '.genesis_time' "$PARAMS_FILE")"

[ "${#DEV_NAMES[@]}" -gt 0 ] || { log "no dev account names in $PARAMS_FILE"; exit 1; }
log "cosmos chain-id=$C_CHAIN_ID  evm chain-id=$E_CHAIN_ID  denom=$DENOM (display $DISPLAY, $DECIMALS decimals)"

# ---------- pull fixed dev/validator mnemonics from the UNMODIFIED upstream script ----------
VAL_MNEMONIC="$(sed -n 's/^[[:space:]]*VAL_MNEMONIC="\(.*\)"[[:space:]]*$/\1/p' "$LOCAL_NODE" | head -n1)"
[ -n "$VAL_MNEMONIC" ] || { log "could not read VAL_MNEMONIC from upstream"; exit 1; }
mapfile -t DEV_MNEMONICS < <(
  awk '/default_mnemonics=\(/{f=1;next} f&&/^[[:space:]]*\)/{exit} f{print}' "$LOCAL_NODE" \
    | grep -oE '"[^"]+"' | tr -d '"'
)
[ "${#DEV_MNEMONICS[@]}" -ge "${#DEV_NAMES[@]}" ] || {
  log "upstream provided ${#DEV_MNEMONICS[@]} dev mnemonics, need ${#DEV_NAMES[@]}"; exit 1; }
log "using $(( ${#DEV_MNEMONICS[@]} )) upstream dev mnemonics + validator mnemonic (nothing stored in repo)"

GENESIS="$NEXORA_HOME/config/genesis.json"
CONFIG_TOML="$NEXORA_HOME/config/config.toml"
APP_TOML="$NEXORA_HOME/config/app.toml"
TMP_GENESIS="$NEXORA_HOME/config/tmp_genesis.json"

jqset() { jq "$@" "$GENESIS" >"$TMP_GENESIS" && mv "$TMP_GENESIS" "$GENESIS"; }

# ---------- clean home ----------
rm -rf "$NEXORA_HOME"
mkdir -p "$NEXORA_HOME"

evmd config set client chain-id "$C_CHAIN_ID" --home "$NEXORA_HOME"
evmd config set client keyring-backend "$KEYRING" --home "$NEXORA_HOME"

# ---------- validator key (from upstream mnemonic; same source init will use) ----------
echo "$VAL_MNEMONIC" | evmd keys add "$VAL_NAME" --recover --keyring-backend "$KEYRING" --algo "$KEYALGO" --home "$NEXORA_HOME"

# ---------- dev keys ----------
for i in "${!DEV_NAMES[@]}"; do
  name="${DEV_NAMES[$i]}"
  echo "${DEV_MNEMONICS[$i]}" | evmd keys add "$name" --recover --keyring-backend "$KEYRING" --algo "$KEYALGO" --home "$NEXORA_HOME"
done

# ---------- init chain (deterministic time comes from the patch below) ----------
echo "$VAL_MNEMONIC" | evmd init "$MONIKER_NAME" -o --chain-id "$C_CHAIN_ID" --home "$NEXORA_HOME" --recover

# ---------- genesis patches (NEXORA identity) ----------
jqset --arg d "$DENOM" --arg disp "$DISPLAY" --arg name "$DNAME" --arg sym "$SYMBOL" --arg desc "$DDESC" \
      --arg exp "$DECIMALS" --arg maxgas "$MAX_GAS" --arg gt "$GENESIS_TIME" '
  # NOTE: the jq builtin walk(f) applies f to LEAVES only, never to the objects that
  # hold a "denom" key. We therefore use our own recursive fixer.
  def fixdenoms:
    if type == "object" then
      ( if has("denom") and (.denom | type) == "string" then .denom = $d else . end )
      | with_entries(.value |= fixdenoms)
    elif type == "array" then map(fixdenoms)
    else . end;

  .genesis_time = $gt
  | .consensus.params.block.max_gas = $maxgas
  # explicit module params (authoritative, documented in chain/nexora-devnet.json)
  | .app_state.staking.params.bond_denom = $d
  | .app_state.mint.params.mint_denom = $d
  | .app_state.evm.params.evm_denom = $d
  # every other denom-bearing object (gov deposits, crisis fee, fee pools, ...)
  | .app_state |= fixdenoms
  # bank metadata drives the EVM coin decimals (LoadEvmCoinInfo reads exponent of the display denom)
  | .app_state.bank.denom_metadata = [{
      description: $desc,
      denom_units: [
        { denom: $d,    exponent: 0,  aliases: [] },
        { denom: $disp, exponent: $exp, aliases: [] }
      ],
      base: $d, display: $disp, name: $name, symbol: $sym, uri: "", uri_hash: ""
    }]
  # native ERC-20 representation of the native coin, same shape as upstream local_node.sh
  | .app_state.erc20.native_precompiles = ["0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"]
  | .app_state.erc20.token_pairs = [{
      contract_owner: 1,
      erc20_address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      denom: $d,
      enabled: true
    }]
  | (if (.app_state.evm.params? | type) == "object"
       and (.app_state.evm.params.extended_denom_options? != null)
     then .app_state.evm.params.extended_denom_options.extended_denom = $d
     else . end)
'

# ---------- fund accounts ----------
for name in "${DEV_NAMES[@]}"; do
  evmd genesis add-genesis-account "$name" "$DEV_BAL" --keyring-backend "$KEYRING" --home "$NEXORA_HOME"
done
evmd genesis add-genesis-account "$VAL_NAME" "$VAL_BAL" --keyring-backend "$KEYRING" --home "$NEXORA_HOME"

# ---------- gentx + collect ----------
evmd genesis gentx "$VAL_NAME" 1000000000000000000000"$DENOM" --gas-prices "$GAS_PRICE" \
  --keyring-backend "$KEYRING" --chain-id "$C_CHAIN_ID" --home "$NEXORA_HOME"
evmd genesis collect-gentxs --home "$NEXORA_HOME"

# ---------- deterministic time must survive the gentx round-trip ----------
jqset --arg gt "$GENESIS_TIME" '.genesis_time = $gt'

# ---------- node config (data only) ----------
sed -i.bak 's/timeout_propose = "3s"/timeout_propose = "2s"/g' "$CONFIG_TOML"
sed -i.bak 's/timeout_propose_delta = "500ms"/timeout_propose_delta = "200ms"/g' "$CONFIG_TOML"
sed -i.bak 's/timeout_prevote = "1s"/timeout_prevote = "500ms"/g' "$CONFIG_TOML"
sed -i.bak 's/timeout_prevote_delta = "500ms"/timeout_prevote_delta = "200ms"/g' "$CONFIG_TOML"
sed -i.bak 's/timeout_precommit = "1s"/timeout_precommit = "500ms"/g' "$CONFIG_TOML"
sed -i.bak 's/timeout_precommit_delta = "500ms"/timeout_precommit_delta = "200ms"/g' "$CONFIG_TOML"
sed -i.bak 's/timeout_commit = "5s"/timeout_commit = "1s"/g' "$CONFIG_TOML"
sed -i.bak 's/timeout_broadcast_tx_commit = "10s"/timeout_broadcast_tx_commit = "5s"/g' "$CONFIG_TOML"

# EVM chain id (EIP-155 replay protection) + fee floor + JSON-RPC, all in app.toml
sed -i.bak "s/^evm-chain-id = .*/evm-chain-id = $E_CHAIN_ID/" "$APP_TOML"
sed -i.bak "s/^minimum-gas-prices = .*/minimum-gas-prices = \"$MIN_GAS_PRICE\"/" "$APP_TOML"
sed -i.bak 's/^enable = false/enable = true/' "$APP_TOML"
sed -i.bak 's/^enabled = false/enabled = true/' "$APP_TOML"

# ---------- validate ----------
evmd genesis validate-genesis --home "$NEXORA_HOME"

# ---------- transcripts ----------
log "=== NEXORA devnet identity (from the generated genesis) ==="
{
  echo "cosmos_chain_id=$(jq -r '.chain_id' "$GENESIS")"
  echo "genesis_time=$(jq -r '.genesis_time' "$GENESIS")"
  echo "staking_bond_denom=$(jq -r '.app_state.staking.params.bond_denom' "$GENESIS")"
  echo "mint_denom=$(jq -r '.app_state.mint.params.mint_denom' "$GENESIS")"
  echo "evm_denom=$(jq -r '.app_state.evm.params.evm_denom' "$GENESIS")"
  echo "erc20_pair_denom=$(jq -r '.app_state.erc20.token_pairs[0].denom' "$GENESIS")"
  echo "bank_base=$(jq -r '.app_state.bank.denom_metadata[0].base' "$GENESIS")"
  echo "bank_display=$(jq -r '.app_state.bank.denom_metadata[0].display' "$GENESIS")"
  echo "display_exponent=$(jq -r '.app_state.bank.denom_metadata[0].denom_units[] | select(.denom == "'"$DISPLAY"'") | .exponent' "$GENESIS")"
  echo "symbol=$(jq -r '.app_state.bank.denom_metadata[0].symbol' "$GENESIS")"
  echo "block_max_gas=$(jq -r '.consensus.params.block.max_gas' "$GENESIS")"
  echo "app_toml_evm_chain_id=$(grep -E '^evm-chain-id' "$APP_TOML" | head -1)"
  echo "app_toml_min_gas_prices=$(grep -E '^minimum-gas-prices' "$APP_TOML" | head -1)"
  echo "genesis_sha256=$(sha256sum "$GENESIS" | cut -d' ' -f1)"
} | tee "$NEXORA_HOME/params-summary.txt"

# ---------- no stale denoms may survive anywhere in genesis ----------
STALE="$(grep -oE '"(stake|atest|aphoton|uatom|aatom|atom)"' "$GENESIS" | sort -u || true)"
if [ -n "$STALE" ]; then
  log "ERROR: stale denoms still present in genesis: $STALE"
  exit 1
fi
log "no stale upstream denoms (stake/atest/aphoton/uatom/aatom) found in genesis"

log "DONE: deterministic genesis ready at $NEXORA_HOME"
