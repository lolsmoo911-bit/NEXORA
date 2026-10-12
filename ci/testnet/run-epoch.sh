#!/usr/bin/env bash
# NEXORA testnet — one EPOCH.
#
# WHY THIS IS SHAPED THIS WAY
# --------------------------
# GitHub Actions runners are ephemeral and GitHub is not a server host. A node that only
# exists inside a job is a demo, not a testnet. So the network is deliberately split:
#
#   DIES     — node processes, CometBFT data directories, the P2P mesh
#   SURVIVES — application state and the ledger, committed to this repository
#
# Each epoch seeds a fresh genesis with the previous epoch's application state, runs four
# validators to consensus, executes a real transfer, and commits the new state back. The
# chain has one continuous history across epochs even though no process outlives a job.
# This is state sync's idea, with git as the archive.
#
# CometBFT restarts at height 1 every epoch because the genesis is re-seeded; the block
# counter does not carry over. Only APPLICATION state carries. The ledger therefore records
# a cumulative block count and the per-epoch height separately, and adding them would be a
# category error.
#
# THIS IS NOT A LIVE RPC ENDPOINT
# -------------------------------
# Nothing answers requests between epochs. For a node that is up at 3am, run
# ci/testnet/start-local-node.sh on a machine you control. That is a real 24/7 network and
# it costs nothing but the machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LEDGER_DIR="$ROOT/testnet"
LEDGER="$LEDGER_DIR/ledger.json"
STATE="$LEDGER_DIR/state.json"
WORK="${WORK:-/tmp/nexora-testnet}"
GENESIS_SH="$ROOT/ci/phase3/gen4-genesis.sh"
HOME_SH="$ROOT/ci/phase3/make-node-home.sh"
EVM="${EVM:-$ROOT/evmd}"
BLOCKS="${BLOCKS:-25}"

export PARAMS_FILE="${PARAMS_FILE:-$ROOT/chain/nexora-devnet.json}"
export COSMOS_EVM_DIR="${COSMOS_EVM_DIR:-/tmp/cosmos-evm}"

NODES=4
KEYRING=test

# Progress goes to stderr on purpose: a `$( ... )` capture must never pick up a log line.
log() { printf '[testnet] %s\n' "$*" >&2; }
die() { printf '[testnet] FATAL: %s\n' "$*" >&2; exit 1; }

# Port plan. Phase 3's layout, which is proven to work on a single runner: p2p and the
# CometBFT RPC interleave from 26656, and the json-rpc, grpc, pprof and metrics listeners
# occupy separate bands so no two nodes ever contend for one.
#
# Always call these as `$(f "$i")`. Writing `$(( f "$i" + 2 ))` is arithmetic expansion,
# which does not evaluate a function call, and bash reports that as an unbound variable
# named after the function — a message that reads like a missing variable, not a typo.
ip_for()       { echo "127.0.0.$(( 1 + $1 ))"; }
p2p_port()     { echo $(( 26656 + 2 * $1 )); }
tend_port()    { echo $(( 26657 + 2 * $1 )); }
rpc_port()     { echo $(( 8545 + $1 )); }
grpc_port()    { echo $(( 9090 + $1 )); }
pprof_port()   { echo $(( 6060 + $1 )); }
metrics_port() { echo $(( 26670 + $1 )); }

# CometBFT p2p id: hex(sha256(public key)[:20]).
#
# Measured for this build: node_key.json holds ONLY priv_key, there is no pub_key field, and
# the decoded key is 64 bytes — an ed25519 seed followed by the public key. The id comes from
# the LAST 32 bytes. Hashing all 64 yields an id the node does not hold, and every dial then
# fails with `auth failure: conn.ID (...) dialed ID (...) mismatch`.
node_id_of() {
  python3 - "$1/config/priv_validator_key.json" <<'PY'
import base64, hashlib, json, sys
d = json.load(open(sys.argv[1]))
raw = base64.b64decode(d["priv_key"]["value"])
print(hashlib.sha256(raw[-32:]).hexdigest()[:40])
PY
}

# Read a value by dotted path, so `fees.min_gas_price` works as well as `evm_chain_id`.
json_get() {
  python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
for key in sys.argv[2].split('.'):
    d = d[key]
print(d)
" "$@"
}

command -v "$EVM" >/dev/null 2>&1 || [ -x "$EVM" ] || die "evmd not found at $EVM (set EVM=...)"

mkdir -p "$LEDGER_DIR"
rm -rf "$WORK"; mkdir -p "$WORK"

# --------------------------------------------------------------------- resume point

EPOCH=1
CUMULATIVE=0
PREV_APP_HASH="(none)"
if [ -f "$LEDGER" ]; then
  EPOCH=$(( $(json_get "$LEDGER" epoch) + 1 ))
  CUMULATIVE=$(json_get "$LEDGER" cumulativeBlocks)
  PREV_APP_HASH=$(json_get "$LEDGER" appHash)
fi
log "epoch $EPOCH | prior: $CUMULATIVE blocks, app_hash ${PREV_APP_HASH:0:16}"

# --------------------------------------------------------------------- genesis

# The phase-3 scripts are invoked through `bash`, never as executables.
#
# Every file here is committed with mode 100644 — this project pushes through the git tree
# API rather than a working tree, and nothing sets the execute bit. A script called as
# "$SCRIPT" therefore dies with "Permission denied" at the first call, which reads like a
# broken script rather than a missing permission bit. `bash "$SCRIPT"` removes the dependency
# on the mode entirely.
# The phase-3 scripts are invoked through `bash`, never as executables.
#
# Every file in this repository is committed with mode 100644 — this project pushes through
# the git tree API rather than a working tree, and nothing sets the execute bit. A script
# called as "$SCRIPT" therefore dies with "Permission denied" at its first call, which reads
# like a broken script rather than a missing permission bit. `bash "$SCRIPT"` removes the
# dependency on the mode entirely.
#
# gen4-genesis.sh takes TWO arguments: the home to build and a directory for its artifacts.
# Passing one fails with "2: output dir required", which is a correct complaint about a
# wrong call rather than a broken script.
log "building the 4-validator genesis"
GEN_HOME="$WORK/genesis-home"
GEN_ARTIFACTS="$WORK/genesis-artifacts"
bash "$GENESIS_SH" "$GEN_HOME" "$GEN_ARTIFACTS" || die "genesis generation failed"

# A state file counts only if it actually carries app_state. A placeholder file — or one
# truncated by a killed job — must be treated as "no history yet" rather than crashing the
# epoch with a KeyError. Losing history is bad; refusing to start because of a stray
# placeholder is worse, and the distinction is checked here rather than assumed.
HAVE_PRIOR_STATE=0
if [ -s "$STATE" ]; then
  HAVE_PRIOR_STATE=$(python3 -c "
import json, sys
try:
    d = json.load(open('$STATE'))
except Exception:
    print(0); sys.exit()
print(1 if isinstance(d, dict) and isinstance(d.get('app_state'), dict) and d['app_state'] else 0)
")
fi

if [ "$HAVE_PRIOR_STATE" -eq 1 ]; then
  log "seeding genesis with the previous epoch's application state"
  python3 - "$GEN_HOME/config/genesis.json" "$STATE" <<'PY'
import json, sys
genesis_path, state_path = sys.argv[1], sys.argv[2]
genesis = json.load(open(genesis_path))
snapshot = json.load(open(state_path))
genesis["app_state"] = snapshot["app_state"]
json.dump(genesis, open(genesis_path, "w"), indent=2)
PY
  log "state injected ($(du -h "$STATE" | cut -f1))"
else
  if [ -e "$STATE" ]; then
    log "state file present but carries no app_state — ignoring it"
  fi
  log "no usable prior state — this is the genesis epoch"
fi

SHARED="$WORK/genesis.json"
cp "$GEN_HOME/config/genesis.json" "$SHARED"
log "genesis sha256 $(sha256sum "$SHARED" | cut -d' ' -f1)"

# --------------------------------------------------------------------- node homes

# The template home is the fully-initialised genesis home, which is what make-node-home.sh
# copies key material from. Pointing it at a directory that does not exist produces a node
# home with no keys, which fails much later and much less legibly.
TEMPLATE="$GEN_HOME"
for i in $(seq 0 $((NODES - 1))); do
  bash "$HOME_SH" "$i" "$SHARED" "$WORK/node$i" "$TEMPLATE" || die "could not provision node$i"
done
log "provisioned $NODES node homes"

# --------------------------------------------------------------------- wire the mesh
#
# An earlier version passed `--address` and `--pprof_laddr` on the command line. Neither is a
# flag in this build: the p2p listen address and the pprof listener live in config.toml, and
# `evmd` responded by printing its whole help text and exiting. The node log then contained
# 150 lines of flag documentation and nothing resembling a cause, which is why this now uses
# the exact flag set Phase 3 proved on the same binary.
#
# CometBFT will not add loopback addresses to its address book ("Cannot add non-routable
# address"), so on a single runner the book is disabled and every peer comes from
# persistent_peers instead.

declare -a NODEID
for i in $(seq 0 $((NODES - 1))); do
  NODEID[$i]="$(node_id_of "$WORK/node$i")"
  [ -n "${NODEID[$i]}" ] || die "could not derive the p2p id for node$i"
  log "node$i p2p id = ${NODEID[$i]}"
done

for i in $(seq 0 $((NODES - 1))); do
  CFG="$WORK/node$i/config/config.toml"

  PEERS=""
  for j in $(seq 0 $((NODES - 1))); do
    if [ "$i" = "$j" ]; then continue; fi
    if [ -n "$PEERS" ]; then PEERS="$PEERS,"; fi
    PEERS="$PEERS${NODEID[$j]}@$(ip_for "$j"):$(p2p_port "$j")"
  done
  sed -i.bak "s/^persistent_peers = .*/persistent_peers = \"$PEERS\"/" "$CFG"

  # external_address must be host:port ONLY. The node prepends its own id, so writing
  # "id@host:port" produced "id@id@host:port" and every node died on startup.
  EXT="$(ip_for "$i"):$(p2p_port "$i")"
  if grep -q '^external_address' "$CFG"; then
    sed -i "s|^external_address = .*|external_address = \"$EXT\"|" "$CFG"
  else
    printf 'external_address = "%s"\n' "$EXT" >> "$CFG"
  fi
  if grep -q '^addr_book_strict' "$CFG"; then
    sed -i "s/^addr_book_strict = .*/addr_book_strict = false/" "$CFG"
  else
    printf 'addr_book_strict = false\n' >> "$CFG"
  fi
  # Several validators on one runner legitimately share the host's address space; CometBFT
  # drops such peers by default, which surfaces as a handshake that dies mid-way.
  if grep -q '^allow_duplicate_ip' "$CFG"; then
    sed -i "s/^allow_duplicate_ip = .*/allow_duplicate_ip = true/" "$CFG"
  else
    printf 'allow_duplicate_ip = true\n' >> "$CFG"
  fi
  # The pprof listener has no CLI flag in this build. Discover the real key rather than
  # assuming one. A pprof bind failure is non-fatal: measured, all four nodes stayed up while
  # fighting over the default port, so this is best effort and says so.
  PKEY="$(grep -oE '^pprof[a-z_-]*' "$CFG" | head -1 || true)"
  if [ -n "$PKEY" ]; then
    sed -i "s/^${PKEY} = .*/${PKEY} = \"127.0.0.1:$(pprof_port "$i")\"/" "$CFG" || true
  fi
  log "node$i wired: external=$EXT peers=${PEERS:0:40}..."
done

# --------------------------------------------------------------------- start

PIDS=()
for i in $(seq 0 $((NODES - 1))); do
  H="$WORK/node$i"
  "$EVM" start \
    --home "$H" \
    --chain-id "$(json_get "$SHARED" chain_id)" \
    --minimum-gas-prices "$(json_get "$PARAMS_FILE" 'fees.min_gas_price')" \
    --evm.evm-chain-id "$(json_get "$PARAMS_FILE" evm_chain_id)" \
    --evm.min-tip 0 \
    --pruning nothing \
    --log_level error \
    --p2p.laddr "tcp://$(ip_for "$i"):$(p2p_port "$i")" \
    --rpc.laddr "tcp://127.0.0.1:$(tend_port "$i")" \
    --grpc.address "127.0.0.1:$(grpc_port "$i")" \
    --evm.geth-metrics-address "127.0.0.1:$(metrics_port "$i")" \
    --json-rpc.enable true \
    --json-rpc.address "127.0.0.1:$(rpc_port "$i")" \
    --json-rpc.api eth,txpool,personal,net,debug,web3 \
    > "$WORK/node$i.log" 2>&1 &
  PIDS+=("$!")
  sleep 2
  kill -0 "${PIDS[$i]}" 2>/dev/null || { tail -20 "$WORK/node$i.log" >&2; die "node$i exited immediately"; }
  log "node$i up (pid ${PIDS[$i]})"
done

RPC0="http://127.0.0.1:$(tend_port 0)"

# --------------------------------------------------------------------- reach height

log "waiting for height $BLOCKS"
DEADLINE=$(( SECONDS + 300 ))
LAST=-1
while :; do
  RUNNING=0; for p in "${PIDS[@]}"; do kill -0 "$p" 2>/dev/null && RUNNING=$((RUNNING+1)); done
  [ "$RUNNING" -gt 0 ] || { tail -20 "$WORK/node0.log" >&2; die "all validators exited"; }

  H=$(curl -fsS "$RPC0/status" 2>/dev/null | python3 -c \
      'import json,sys;print(json.load(sys.stdin)["result"]["sync_info"]["latest_block_height"])' 2>/dev/null || echo 0)
  if [ "$H" != "$LAST" ] && [ "${H:-0}" -gt 0 ] 2>/dev/null; then log "height $H"; LAST=$H; fi
  [ "${H:-0}" -ge "$BLOCKS" ] 2>/dev/null && break
  [ "$SECONDS" -lt "$DEADLINE" ] || die "did not reach height $BLOCKS within 300s"
  sleep 3
done

# --------------------------------------------------------------------- agreement

log "checking all four validators agree"
FIRST=$(curl -fsS "$RPC0/status" | python3 -c \
  'import json,sys;print(json.load(sys.stdin)["result"]["sync_info"]["latest_app_hash"])')
for i in $(seq 1 $((NODES - 1))); do
  A=$(curl -fsS "http://127.0.0.1:$(tend_port "$i")/status" | python3 -c \
      'import json,sys;print(json.load(sys.stdin)["result"]["sync_info"]["latest_app_hash"])')
  [ "$A" = "$FIRST" ] || die "node$i app hash differs from node0"
done
log "4/4 agree: $FIRST"

# --------------------------------------------------------------------- a real transfer

FROM_ADDR=$("$EVM" keys show dev0 --keyring-backend "$KEYRING" --keyring-dir "$WORK/node0/keyring" \
              --home "$WORK/node0" -a)
TO_ADDR=$("$EVM" keys show dev1 --keyring-backend "$KEYRING" --keyring-dir "$WORK/node0/keyring" \
            --home "$WORK/node0" -a)
log "transferring dev0 -> dev1"

BEFORE=$(timeout 45 "$EVM" q bank balances "$TO_ADDR" --node "$RPC0" -o json | python3 -c \
         'import json,sys;print(json.load(sys.stdin)["balances"][0]["amount"])')

TX=$(timeout 90 "$EVM" tx bank send "$FROM_ADDR" "$TO_ADDR" 123456789anex \
      --chain-id "$(json_get "$SHARED" chain_id)" --keyring-backend "$KEYRING" \
      --keyring-dir "$WORK/node0/keyring" --home "$WORK/node0" \
      --node "$RPC0" --fees 2000000000anex --gas 200000 -y -o json 2>/dev/null)
TXHASH=$(printf '%s' "$TX" | python3 -c 'import json,sys;print(json.load(sys.stdin)["txhash"])')
log "tx submitted: $TXHASH"

# Wait for inclusion rather than assuming it. Phase 3 was broken twice by a transaction that
# had already succeeded (`code:0`) being reported as a failure because its output would not
# parse; nothing here treats an unparsed result as a pass or a fail.
INCLUDED=0
for _ in $(seq 1 30); do
  if curl -fsS "$RPC0/tx?hash=0x$TXHASH" >/dev/null 2>&1; then INCLUDED=1; break; fi
  sleep 3
done
[ "$INCLUDED" -eq 1 ] || die "transaction $TXHASH was never included"

AFTER=$(timeout 45 "$EVM" q bank balances "$TO_ADDR" --node "$RPC0" -o json | python3 -c \
        'import json,sys;print(json.load(sys.stdin)["balances"][0]["amount"])')
EXPECTED=$(( BEFORE + 123456789 ))
log "balance $BEFORE -> $AFTER (expected $EXPECTED)"
[ "$AFTER" -eq "$EXPECTED" ] || die "balance did not move by the transferred amount"

# --------------------------------------------------------------------- persist

for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
sleep 4
for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null || true; done
wait 2>/dev/null || true

"$EVM" export --home "$WORK/node0" > "$WORK/export.json" 2>"$WORK/export.err" \
  || die "export failed: $(tail -3 "$WORK/export.err")"

python3 - "$WORK/export.json" "$STATE" "$LEDGER" "$EPOCH" "$BLOCKS" "$CUMULATIVE" "$FIRST" \
         "$TXHASH" "$BEFORE" "$AFTER" <<'PY'
import json, os, sys
export_path, state_path, ledger_path, epoch, height, cumulative, app_hash, tx, before, after = sys.argv[1:11]
export = json.load(open(export_path))

json.dump({"height": export["height"], "app_hash": export["app_hash"], "app_state": export["app_state"]},
          open(state_path, "w"))
os.makedirs(os.path.dirname(ledger_path), exist_ok=True)

previous = json.load(open(ledger_path)) if os.path.exists(ledger_path) else {}
history = previous.get("history", [])
history.append({
    "epoch": int(epoch),
    "height": int(export["height"]),
    "appHash": export["app_hash"],
    "transfer": {"tx": tx, "balanceBefore": before, "balanceAfter": after},
})

json.dump({
    "note": "Durable record of the NEXORA testnet. Application state lives in state.json. "
            "Regenerated by ci/testnet/run-epoch.sh; never edited by hand.",
    "network": "nexora-testnet-1",
    "epoch": int(epoch),
    "height": int(export["height"]),
    "cumulativeBlocks": int(cumulative) + int(export["height"]),
    "appHash": export["app_hash"],
    "history": history,
}, open(ledger_path, "w"), indent=2)
open(ledger_path, "a").write("\n")
PY

log "epoch $EPOCH committed | height $BLOCKS | cumulative $(( CUMULATIVE + BLOCKS )) blocks"
log "transfer $TXHASH settled: $BEFORE -> $AFTER"
