#!/usr/bin/env bash
# NEXORA — Phase 3: build ONE genesis containing 4 validators, deterministically.
#
# Correct multi-validator method (verified empirically):
#   `evmd genesis gentx` rewrites (shuffles) the genesis file on every call, so calling
#   it four times in a single home collapses back to one validator. The working approach
#   is per-validator isolation:
#     1. build ONE clean base genesis (no gentxs)
#     2. for each validator i: copy the base to a scratch home, create the validator key,
#        run a single `gentx`, and keep only the produced gentx file
#     3. collect all 4 gentx files into the target home and run `collect-gentxs`
#   Because every step is derived from the fixed upstream mnemonics and a pinned
#   genesis_time, the resulting genesis is byte-for-byte deterministic.
#
# Usage: gen4-genesis.sh <target_home> <out_dir>
set -euo pipefail

NEXORA_HOME="${1:?target home required}"
OUT_DIR="${2:?output dir required}"
PARAMS_FILE="${PARAMS_FILE:?PARAMS_FILE is required}"
COSMOS_EVM_DIR="${COSMOS_EVM_DIR:-/tmp/cosmos-evm}"
KEYRING="test"
KEYALGO="eth_secp256k1"
SCRATCH="$(mktemp -d /tmp/nexora3scratch.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

log() { echo "[phase3-genesis] $*"; }
LOCAL_NODE="$COSMOS_EVM_DIR/local_node.sh"
[ -f "$LOCAL_NODE" ] || { log "upstream local_node.sh missing"; exit 1; }

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
GENESIS_TIME="$(jq -r '.genesis_time' "$PARAMS_FILE")"

VAL_NAMES=(val0 val1 val2 val3)
SRC_NAMES=(mykey dev0 dev1 dev2)
EXTRA_ACCOUNT="dev3"

VAL_MNEMONIC="$(sed -n 's/^[[:space:]]*VAL_MNEMONIC="\(.*\)"[[:space:]]*$/\1/p' "$LOCAL_NODE" | head -n1)"
mapfile -t DEV_MNEMONICS < <(
  awk '/default_mnemonics=\(/{f=1;next} f&&/^[[:space:]]*\)/{exit} f{print}' "$LOCAL_NODE" \
    | grep -oE '"[^"]+"' | tr -d '"'
)
[ -n "$VAL_MNEMONIC" ] || { log "VAL_MNEMONIC not found upstream"; exit 1; }
[ "${#DEV_MNEMONICS[@]}" -ge 4 ] || { log "need >=4 dev mnemonics upstream"; exit 1; }
VAL_MNEMONICS=("$VAL_MNEMONIC" "${DEV_MNEMONICS[0]}" "${DEV_MNEMONICS[1]}" "${DEV_MNEMONICS[2]}")

GENESIS="$NEXORA_HOME/config/genesis.json"
CONFIG_TOML="$NEXORA_HOME/config/config.toml"
APP_TOML="$NEXORA_HOME/config/app.toml"
TMP_GENESIS="$NEXORA_HOME/config/tmp_genesis.json"
jqset() { jq "$@" "$GENESIS" >"$TMP_GENESIS" && mv "$TMP_GENESIS" "$GENESIS"; }

mkdir -p "$OUT_DIR"
rm -rf "$NEXORA_HOME"; mkdir -p "$NEXORA_HOME"

evmd config set client chain-id "$C_CHAIN_ID" --home "$NEXORA_HOME"
evmd config set client keyring-backend "$KEYRING" --home "$NEXORA_HOME"

for i in 0 1 2 3; do
  echo "${VAL_MNEMONICS[$i]}" | evmd keys add "${VAL_NAMES[$i]}" --recover \
    --keyring-backend "$KEYRING" --algo "$KEYALGO" --home "$NEXORA_HOME" >/dev/null
done
echo "${DEV_MNEMONICS[3]}" | evmd keys add "$EXTRA_ACCOUNT" --recover \
  --keyring-backend "$KEYRING" --algo "$KEYALGO" --home "$NEXORA_HOME" >/dev/null

# ---------- base genesis (validator 0 mnemonic seeds priv_validator_key.json) ----------
echo "${VAL_MNEMONICS[0]}" | evmd init "nexora-node-0" -o --chain-id "$C_CHAIN_ID" --home "$NEXORA_HOME" --recover >/dev/null

jqset --arg d "$DENOM" --arg disp "$DISPLAY" --arg name "$DNAME" --arg sym "$SYMBOL" --arg desc "$DDESC" \
      --arg exp "$DECIMALS" --arg maxgas "$MAX_GAS" --arg gt "$GENESIS_TIME" '
  def fixdenoms:
    if type == "object" then
      ( if has("denom") and (.denom | type) == "string" then .denom = $d else . end )
      | with_entries(.value |= fixdenoms)
    elif type == "array" then map(fixdenoms)
    else . end;

  .genesis_time = $gt
  | .consensus.params.block.max_gas = $maxgas
  | .app_state.staking.params.bond_denom = $d
  | .app_state.mint.params.mint_denom = $d
  | .app_state.evm.params.evm_denom = $d
  | .app_state |= fixdenoms
  | .app_state.bank.denom_metadata = [{
      description: $desc,
      denom_units: [
        { denom: $d,    exponent: 0,  aliases: [] },
        { denom: $disp, exponent: $exp, aliases: [] }
      ],
      base: $d, display: $disp, name: $name, symbol: $sym, uri: "", uri_hash: ""
    }]
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

for name in "${VAL_NAMES[@]}"; do
  evmd genesis add-genesis-account "$name" "$VAL_BAL" --keyring-backend "$KEYRING" --home "$NEXORA_HOME"
done
evmd genesis add-genesis-account "$EXTRA_ACCOUNT" "$DEV_BAL" --keyring-backend "$KEYRING" --home "$NEXORA_HOME"

# ---------- one gentx per validator, each in its own scratch home ----------
BASE_GENESIS="$SCRATCH/base-genesis.json"
cp "$GENESIS" "$BASE_GENESIS"
for i in 0 1 2 3; do
  SH="$SCRATCH/v$i"
  # the client config must be valid BEFORE init (init refuses an empty chain-id)
  evmd config set client chain-id "$C_CHAIN_ID" --home "$SH"
  evmd config set client keyring-backend "$KEYRING" --home "$SH"
  echo "${VAL_MNEMONICS[$i]}" | evmd init "nexora-node-$i" -o --chain-id "$C_CHAIN_ID" --home "$SH" --recover >/dev/null
  # reuse the funded genesis so the signing account/sequence match
  cp "$BASE_GENESIS" "$SH/config/genesis.json"
  echo "${VAL_MNEMONICS[$i]}" | evmd keys add "${VAL_NAMES[$i]}" --recover \
    --keyring-backend "$KEYRING" --algo "$KEYALGO" --home "$SH" >/dev/null
  evmd genesis gentx "${VAL_NAMES[$i]}" 1000000000000000000000"$DENOM" --gas-prices "$GAS_PRICE" \
    --keyring-backend "$KEYRING" --chain-id "$C_CHAIN_ID" --home "$SH" \
    --node-id "nexoraval$i" --ip "127.0.0.1" --moniker "nexora-node-$i" >/dev/null
  GTX="$(ls "$SH/config/gentx/"*.json 2>/dev/null | head -1 || true)"
  [ -n "$GTX" ] || { log "ERROR: validator $i produced no gentx"; exit 1; }
  mkdir -p "$NEXORA_HOME/config/gentx"
  cp "$GTX" "$NEXORA_HOME/config/gentx/"
  log "validator $i gentx collected: $(basename "$GTX")"
done

evmd genesis collect-gentxs --home "$NEXORA_HOME"
jqset --arg gt "$GENESIS_TIME" '.genesis_time = $gt'

# ---------- node config ----------
sed -i.bak 's/timeout_propose = "3s"/timeout_propose = "200ms"/g' "$CONFIG_TOML"
sed -i.bak 's/timeout_propose_delta = "500ms"/timeout_propose_delta = "100ms"/g' "$CONFIG_TOML"
sed -i.bak 's/timeout_prevote = "1s"/timeout_prevote = "200ms"/g' "$CONFIG_TOML"
sed -i.bak 's/timeout_prevote_delta = "500ms"/timeout_prevote_delta = "100ms"/g' "$CONFIG_TOML"
sed -i.bak 's/timeout_precommit = "1s"/timeout_precommit = "200ms"/g' "$CONFIG_TOML"
sed -i.bak 's/timeout_precommit_delta = "500ms"/timeout_precommit_delta = "100ms"/g' "$CONFIG_TOML"
sed -i.bak 's/timeout_commit = "5s"/timeout_commit = "500ms"/g' "$CONFIG_TOML"
sed -i.bak 's/type = "flood"/type = "app"/g' "$CONFIG_TOML"
sed -i.bak "s/^evm-chain-id = .*/evm-chain-id = $E_CHAIN_ID/" "$APP_TOML"
sed -i.bak "s/^minimum-gas-prices = .*/minimum-gas-prices = \"$MIN_GAS_PRICE\"/" "$APP_TOML"
sed -i.bak 's/^enable = false/enable = true/' "$APP_TOML"
sed -i.bak 's/^enabled = false/enabled = true/' "$APP_TOML"

evmd genesis validate-genesis --home "$NEXORA_HOME"

NGENTX="$(jq -r '.app_state.genutil.gen_txs | length' "$GENESIS")"
# MsgCreateValidator carries validator_address at the top level (not under .delegation)
NVADDR="$(jq -r '[.app_state.genutil.gen_txs[].body.messages[0].validator_address] | unique | length' "$GENESIS")"
NSELF="$(jq -r '[.app_state.genutil.gen_txs[].body.messages[0].value.amount] | unique | length' "$GENESIS")"
NMONIK="$(jq -r '[.app_state.genutil.gen_txs[].body.messages[0].description.moniker] | unique | length' "$GENESIS")"
SHA="$(sha256sum "$GENESIS" | cut -d' ' -f1)"
{
  echo "chain_id=$C_CHAIN_ID"
  echo "evm_chain_id=$E_CHAIN_ID"
  echo "denom=$DENOM display=$DISPLAY decimals=$DECIMALS"
  echo "gentxs_in_genesis=$NGENTX"
  echo "distinct_validator_addresses=$NVADDR"
  echo "distinct_self_delegations=$NSELF"
  echo "distinct_monikers=$NMONIK"
  echo "genesis_sha256=$SHA"
} | tee "$OUT_DIR/genesis-summary.txt"

[ "$NGENTX" = "4" ] || { log "ERROR: expected 4 gentxs in genesis, got $NGENTX"; exit 1; }
[ "$NVADDR" = "4" ] || { log "ERROR: expected 4 distinct validator addresses, got $NVADDR"; exit 1; }
cp "$GENESIS" "$OUT_DIR/genesis-4val.json"
log "OK: deterministic 4-validator genesis ready at $NEXORA_HOME"