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
ws_port()      { echo $(( 8645 + $1 )); }
grpc_port()    { echo $(( 9090 + $1 )); }
pprof_port()   { echo $(( 6060 + $1 )); }
metrics_port() { echo $(( 26670 + $1 )); }

# Port plan assertion, before a single node starts.
#
# Measured failure this prevents: node1 died with "failed to start json-rpc server: listen
# tcp 127.0.0.1:8546: bind: address already in use" — node0's json-rpc websocket listener
# had fallen back to its DEFAULT of 8546, which is exactly node1's json-rpc port. The two
# only collided because the websocket address was not passed explicitly.
#
# A colliding port produces a node that dies two seconds after start, with the reason buried
# in a log that is mostly flag documentation. Checking the plan up front costs nothing.
assert_port_plan() {
  local plan dups bound
  plan=""
  for i in $(seq 0 $((NODES - 1))); do
    plan="$plan $(p2p_port "$i") $(tend_port "$i") $(rpc_port "$i") $(ws_port "$i") \
$(grpc_port "$i") $(pprof_port "$i") $(metrics_port "$i")"
  done

  dups="$(tr ' ' '\n' <<< "$plan" | grep -v '^$' | sort | uniq -d | tr '\n' ' ')"
  if [ -n "$dups" ]; then
    log "ERROR: port plan contains duplicates:$dups"
    exit 1
  fi

  for p in $plan; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
      exec 3<&- 2>/dev/null || true
      log "ERROR: port $p is already bound on this runner"
      bound=1
    fi
  done
  if [ "${bound:-0}" -eq 1 ]; then
    log "  fix the port plan rather than retrying; a rebind will fail the same way"
    exit 1
  fi
  log "port plan OK: $(tr ' ' '\n' <<< "$plan" | grep -c .) distinct listeners, none already bound"
}

# CometBFT p2p id: hex(sha256(public key)[:20]).
#
# This MUST read config/node_key.json. config/priv_validator_key.json holds the CONSENSUS key
# — the key the validator signs blocks and votes with — and its address is a different string.
# Naming a peer by that address makes every dial fail with:
#     auth failure: conn.ID (<real id>) dialed ID (<consensus address>) mismatch
# which reads like a key-encoding bug rather than "wrong file".
#
# Both files hold a 64-byte ed25519 key (a seed followed by the public key) and neither has a
# pub_key field, so the id is sha256 over the LAST 32 bytes, hex, truncated to 40 chars.
# Measured against a running node's own /status node_info.id, node_key.json matches exactly.
node_id_of() {
  python3 - "$1/config/node_key.json" <<'PY'
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

assert_port_plan

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
    --json-rpc.ws-address "127.0.0.1:$(ws_port "$i")" \
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

# Comparing each node's LATEST app_hash in sequence races the block clock: the chain is still
# producing roughly one block a second, so a node read a moment later can legitimately be one
# block ahead, and the epoch dies with "app hash differs" against a healthy network.
#
# Compare the SAME height on every node instead. H is the lowest height any node reports, so
# all four are guaranteed to have committed it, and the app_hash comes out of that block's
# header rather than out of whichever node happened to be read first.
HEIGHT_FIELD='["result"]["sync_info"]["latest_block_height"]'
HEIGHTS=""
for i in $(seq 0 $((NODES - 1))); do
  H=$(curl -fsS "http://127.0.0.1:$(tend_port "$i")/status" 2>/dev/null | python3 -c \
      "import json,sys;print(json.load(sys.stdin)$HEIGHT_FIELD)" 2>/dev/null || echo 0)
  [ "${H:-0}" -ge 1 ] 2>/dev/null || die "node$i reports no height"
  HEIGHTS="$HEIGHTS $H"
done
H=$(tr ' ' '\n' <<< "$HEIGHTS" | grep -E '^[0-9]+$' | sort -n | head -1)
[ -n "$H" ] || die "could not determine a common height"
log "comparing app_hash at height $H"

FIRST=""
for i in $(seq 0 $((NODES - 1))); do
  A=$(curl -fsS "http://127.0.0.1:$(tend_port "$i")/block?height=$H" 2>/dev/null | python3 -c \
      'import json,sys;print(json.load(sys.stdin)["result"]["block"]["header"]["app_hash"])' \
      2>/dev/null || echo "")
  [ -n "$A" ] || die "node$i has no block at height $H"
  if [ -z "$FIRST" ]; then FIRST="$A"; else
    [ "$A" = "$FIRST" ] || die "node$i app hash differs from node0 at height $H"
  fi
done
log "4/4 agree at height $H: $FIRST"

# --------------------------------------------------------------------- a real transfer

# The keys that exist in a provisioned node home are val0..val3 (this node's validator) and
# dev3. make-node-home.sh imports exactly those two; dev0/dev1/dev2 live only in the genesis
# template home, so `keys show dev0` here fails with "is not a valid name or address" and the
# epoch dies at a place that looks like a keyring problem.
#
# Do NOT pass --keyring-dir alongside --home. The `test` backend resolves to $HOME/keyring-test,
# while --keyring-dir "$WORK/node0/keyring" points it at "$WORK/node0/keyring/keyring-test",
# which exists and is empty. The result is a keyring that lists nothing, and `keys show val0`
# then reports "decoding bech32 failed" — as if the key name were an address.
FROM_ADDR=$("$EVM" keys show val0 --keyring-backend "$KEYRING" --home "$WORK/node0" -a)
TO_ADDR=$("$EVM" keys show dev3 --keyring-backend "$KEYRING" --home "$WORK/node0" -a)
log "transferring val0 -> dev3"

BEFORE=$(timeout 45 "$EVM" q bank balances "$TO_ADDR" --node "$RPC0" -o json | python3 -c \
         'import json,sys;print(json.load(sys.stdin)["balances"][0]["amount"])')

# `--gas-prices` is a price PER GAS UNIT; `--fees` is the total for the whole tx. Passing
# `--fees 2000000000anex --gas 200000` therefore buys 10000anex per gas, while feemarket's
# base fee starts at 1e9anex per gas and only decays — the tx is rejected in CheckTx with
# `code: 13, gas prices too low` and never enters a block, so the wait below reports
# "was never included" for a transaction that failed long before inclusion. The fee has to
# clear the CURRENT base fee, so set the price, not the total.
TX=$(timeout 90 "$EVM" tx bank send "$FROM_ADDR" "$TO_ADDR" 123456789anex \
      --chain-id "$(json_get "$SHARED" chain_id)" --keyring-backend "$KEYRING" \
      --home "$WORK/node0" \
      --node "$RPC0" --gas-prices "$(json_get "$PARAMS_FILE" 'fees.gas_price')" \
      --gas 200000 -y -o json 2>"$WORK/tx.err") || \
  die "tx submission failed: $(tail -3 "$WORK/tx.err")"

# A submission can also "succeed" at the CLI and still carry a non-zero code in the body —
# CheckTx rejections come back as a normal JSON result. Reading txhash out of that is what
# turns a rejected transaction into a 90-second wait for something that will never be mined.
TXCODE=$(printf '%s' "$TX" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("code",0))')
[ "$TXCODE" = "0" ] || die "transaction rejected in CheckTx (code $TXCODE): $(printf '%s' "$TX" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("raw_log",""))')"
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
# NOT $(( BEFORE + 123456789 )). A genesis balance is a base-18-decimal amount, so it is around
# 1e21 — past the top of a signed 64-bit integer. Bash arithmetic wraps instead of growing, and
# this exact balance wraps to 3875820019807669525, so the check below fails against a transfer
# that moved the money by exactly the right amount. Python integers are arbitrary precision.
EXPECTED=$(python3 -c "print($BEFORE + 123456789)")
log "balance $BEFORE -> $AFTER (expected $EXPECTED)"
[ "$AFTER" = "$EXPECTED" ] || die "balance did not move by the transferred amount"

# --------------------------------------------------------------------- persist

# Capture the final height and the app_hash committed AT that height, while the nodes are still
# up. `evmd export` cannot supply either: its document carries `initial_height`, not `height`,
# and its `app_hash` field is null in this build — which is how a ledger ends up recording
# "appHash": null next to a real height, claiming agreement it never recorded.
FINAL_HEIGHT=$(curl -fsS "$RPC0/status" | python3 -c \
  'import json,sys;print(json.load(sys.stdin)["result"]["sync_info"]["latest_block_height"])')
FINAL_HASH=$(curl -fsS "$RPC0/block?height=$FINAL_HEIGHT" | python3 -c \
  'import json,sys;print(json.load(sys.stdin)["result"]["block"]["header"]["app_hash"])')
log "recording height $FINAL_HEIGHT, app_hash $FINAL_HASH"

for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
sleep 4
for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null || true; done
wait 2>/dev/null || true

# --log_level error because `evmd export` writes its startup logs to STDOUT, not stderr, and
# those lines land ahead of the JSON in export.json. Parsing then dies with "Expecting value:
# line 1 column 1" — which reads like a truncated export rather than a logging stream sharing
# the file. The parser below also skips to the first '{' so a stray line cannot break the epoch.
"$EVM" export --home "$WORK/node0" --log_level error > "$WORK/export.json" 2>"$WORK/export.err" \
  || die "export failed: $(tail -3 "$WORK/export.err")"

python3 - "$WORK/export.json" "$STATE" "$LEDGER" "$EPOCH" "$FINAL_HEIGHT" "$CUMULATIVE" \
         "$FINAL_HASH" "$TXHASH" "$BEFORE" "$AFTER" <<'PY'
import json, os, sys
export_path, state_path, ledger_path, epoch, height, cumulative, app_hash, tx, before, after = sys.argv[1:11]
raw = open(export_path).read()
# Skip any leading log lines; the document itself starts at the first '{'.
export = json.loads(raw[raw.index("{"):])

# height and app_hash come from the chain, not from the export: `evmd export` in this build
# writes `initial_height` (not `height`) and leaves `app_hash` null, so reading them from the
# document records a height with no hash beside it — a ledger that looks complete and proves
# nothing. The export is still the source of truth for app_state.
record_height = int(height)
record_hash = app_hash
export_height = export.get("initial_height", export.get("height"))

json.dump({"height": record_height, "app_hash": record_hash, "app_state": export["app_state"]},
          open(state_path, "w"))
os.makedirs(os.path.dirname(ledger_path), exist_ok=True)

previous = json.load(open(ledger_path)) if os.path.exists(ledger_path) else {}
history = previous.get("history", [])
history.append({
    "epoch": int(epoch),
    "height": record_height,
    "appHash": record_hash,
    "exportHeight": export_height,
    "transfer": {"tx": tx, "balanceBefore": before, "balanceAfter": after},
})

json.dump({
    "note": "Durable record of the NEXORA testnet. Application state lives in state.json. "
            "Regenerated by ci/testnet/run-epoch.sh; never edited by hand.",
    "network": "eip155:902024",
    "epoch": int(epoch),
    "height": record_height,
    "cumulativeBlocks": int(cumulative) + record_height,
    "appHash": record_hash,
    "history": history,
}, open(ledger_path, "w"), indent=2)
open(ledger_path, "a").write("\n")
PY

log "epoch $EPOCH committed | height $FINAL_HEIGHT | cumulative $(( CUMULATIVE + FINAL_HEIGHT )) blocks"
log "transfer $TXHASH settled: $BEFORE -> $AFTER"
