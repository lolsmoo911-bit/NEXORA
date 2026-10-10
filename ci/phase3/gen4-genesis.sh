#!/usr/bin/env bash
# NEXORA — Phase 3: multi-validator devnet (4 independent validators).
#
# Design constraints:
#   - The upstream reference is cloned fresh and NEVER modified.
#   - All nodes start from ONE byte-identical deterministic genesis.
#   - Validators use the upstream public test mnemonics parsed at runtime
#     (mykey, dev0, dev1, dev2). No key material lives in this repository.
#   - Every port/endpoint is offset per validator so four nodes can share a runner.
#
# Usage: gen4-genesis.sh <target_home> <out_dir>
set -euo pipefail

NEXORA_HOME="${1:?target home required}"
OUT_DIR="${2:?output dir required}"
PARAMS_FILE="${PARAMS_FILE:?PARAMS_FILE is required}"
COSMOS_EVM_DIR="${COSMOS_EVM_DIR:-/tmp/cosmos-evm}"
KEYRING="test"
KEYALGO="eth_secp256k1"

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

# four validators from upstream mnemonics: mykey + dev0..dev2 ; dev3 stays a plain account
VAL_NAMES=(val0 val1 val2 val3)
SRC_NAMES=(mykey dev0 dev1 dev2)
EXTRA_ACCOUNT="dev3"

VAL_MNEMONIC="$(sed -n 's/^[[:space:]]*VAL_MNEMONIC="\(.*\)"[[:space:]]*$/\1/p' "$LOCAL_NODE" | head -n1)"
mapfile -t DEV_MNEMONICS < <(
  awk '/default_mnemonics=\(/{f=1;next} f&&/^[[:space:]]*\)/{exit} f{print}' "$LOCAL_NODE" \
    | grep -oE '"[^"]+"' | tr -d '"'
)
[ -n "$VAL_MNEMONIC" ] || { log "VAL_MNEMONIC not found upstream"; exit 1; }
[ "${#DEV_MNEMONICS[@]}" -ge 3 ] || { log "need >=3 dev mnemonics upstream"; exit 1; }

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

# ---------- keys ----------
for i in 0 1 2 3; do
  echo "${VAL_MNEMONICS[$i]}" | evmd keys add "${VAL_NAMES[$i]}" --recover \
    --keyring-backend "$KEYRING" --algo "$KEYALGO" --home "$NEXORA_HOME" >/dev/null
done
echo "${DEV_MNEMONICS[3]}" | evmd keys add "$EXTRA_ACCOUNT" --recover \
  --keyring-backend "$KEYRING" --algo "$KEYALGO" --home "$NEXORA_HOME" >/dev/null

# ---------- init (validator 0 mnemonic seeds priv_validator_key.json) ----------
echo "${VAL_MNEMONICS[0]}" | evmd init "nexora-node-0" -o --chain-id "$C_CHAIN_ID" --home "$NEXORA_HOME" --recover >/dev/null

# ---------- NEXORA genesis identity (same rules as Phase 2) ----------
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

# ---------- fund ----------
# validators get the larger balance; the extra dev account is funded separately
# (funding it here as well would be a duplicate genesis account and is rejected)
for name in "${VAL_NAMES[@]}"; do
  evmd genesis add-genesis-account "$name" "$VAL_BAL" --keyring-backend "$KEYRING" --home "$NEXORA_HOME"
done
evmd genesis add-genesis-account "$EXTRA_ACCOUNT" "$DEV_BAL" --keyring-backend "$KEYRING" --home "$NEXORA_HOME"

# ---------- gentx per validator (pinned node-id/ip => deterministic bytes) ----------
for i in 0 1 2 3; do
  evmd genesis gentx "${VAL_NAMES[$i]}" 1000000000000000000000"$DENOM" --gas-prices "$GAS_PRICE" \
    --keyring-backend "$KEYRING" --chain-id "$C_CHAIN_ID" --home "$NEXORA_HOME" \
    --node-id "nexoraval$i" --ip "127.0.0.1" --moniker "nexora-node-$i" >/dev/null
done
evmd genesis collect-gentxs --home "$NEXORA_HOME"

jqset --arg gt "$GENESIS_TIME" '.genesis_time = $gt'

# ---------- node config (offsets applied later per node) ----------
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

# ---------- proof: how many validators are in genesis ----------
NVAL="$(jq -r '.app_state.staking.validators | length' "$GENESIS")"
NGENTX="$(jq -r '.app_state.genutil.gen_txs | length' "$GENESIS")"
SHA="$(sha256sum "$GENESIS" | cut -d' ' -f1)"
{
  echo "chain_id=$C_CHAIN_ID"
  echo "evm_chain_id=$E_CHAIN_ID"
  echo "denom=$DENOM display=$DISPLAY decimals=$DECIMALS"
  echo "validators_in_genesis=$NVAL"
  echo "gentxs=$NGENTX"
  echo "genesis_sha256=$SHA"
} | tee "$OUT_DIR/genesis-summary.txt"

[ "$NVAL" = "4" ] || { log "ERROR: expected 4 validators in genesis, got $NVAL"; exit 1; }
cp "$GENESIS" "$OUT_DIR/genesis-4val.json"
log "OK: 4-validator deterministic genesis ready at $NEXORA_HOME"
