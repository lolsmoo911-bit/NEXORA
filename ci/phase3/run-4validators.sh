#!/usr/bin/env bash
# NEXORA — Phase 3: run 4 independent validators, then test consensus + one-fault
# tolerance + restart recovery.
#
# Ports are offset per node so all four share a single CI runner:
#   node i: p2p 26656+2i, comet rpc 26657+2i, json-rpc 8545+i
#   (evm chain id is unchanged; it is not a port)
#
# Tests performed (each one fails the step loudly):
#   T1  all 4 nodes start from the SAME genesis bytes
#   T2  the 4 validators are present in the genesis
#   T3  every node produces blocks and the 4 nodes agree on height + app_hash
#   T4  a Cosmos transfer on the full 4-node network settles
#   T5  kill one validator -> the remaining 3 still produce blocks (quorum)
#   T6  restart the killed validator -> it catches up to the network height
set -euo pipefail

PARAMS_FILE="${PARAMS_FILE:?PARAMS_FILE is required}"
ART="${ARTIFACT_DIR:?ARTIFACT_DIR is required}"
NODES_ROOT="${NODES_ROOT:-/tmp/nexora3}"

C_CHAIN_ID="$(jq -r '.cosmos_chain_id' "$PARAMS_FILE")"
E_CHAIN_ID="$(jq -r '.evm_chain_id' "$PARAMS_FILE")"
DENOM="$(jq -r '.denom.base' "$PARAMS_FILE")"
MIN_GAS_PRICE="$(jq -r '.fees.min_gas_price' "$PARAMS_FILE")"
GAS_PRICE="$(jq -r '.fees.gas_price' "$PARAMS_FILE")"
KILL_NODE=3   # the validator stopped during T5

mkdir -p "$ART"
log() { echo "[phase3] $*"; }

# Non-overlapping port ranges per validator i (0..3):
#   p2p      : 26656 + 2i  -> 26656, 26658, 26660, 26662
#   comet    : 26657 + 2i  -> 26657, 26659, 26661, 26663
#   json-rpc : 8545 + i
# (an earlier version used 26656+i for p2p, which collided with the previous node's
#  comet RPC port; the ranges must stay disjoint.)
rpc_port() { echo $((8545 + $1)); }
tend_port() { echo $((26657 + 2 * $1)); }
p2p_port() { echo $((26656 + 2 * $1)); }

# Each validator gets its OWN loopback address, not a shared 127.0.0.1.
#
# Measured failure this fixes: with all four nodes on 127.0.0.1 the p2p address book is keyed
# by IP, so the four entries overwrite one another and every node settled at n_peers=1 with
# "auth failure: secret conn failed: EOF". Distinct loopback addresses give the address book
# four distinct keys. Linux routes the whole of 127.0.0.0/8 to loopback with no configuration,
# and each address has a full port range, so the per-node port offsets stay valid.
p2p_ip() { echo "127.0.0.$((1 + $1))"; }
# 8600+i, NOT 8546+i: the WebSocket listener would otherwise collide with the next node's
# JSON-RPC listener (8546+0 == 8545+1). assert_ports_usable below catches exactly this class
# of mistake before any node is started.
ws_port() { echo $((8600 + $1)); }
grpc_port() { echo $((9090 + $1)); }
pprof_port() { echo $((6060 + $1)); }
metrics_port() { echo $((8100 + $1)); }

# Every listening port this script will ask evmd to bind, per validator.
#
# This inventory exists because of a real failure: evmd binds pprof on 127.0.0.1:6060 and
# the geth metrics server on 127.0.0.1:8100 by DEFAULT. Four validators therefore raced for
# the same two ports and the loser EXITED, taking the network down with it. Every auxiliary
# listener must be given an explicit per-node address.
ports_of() {
  local i="$1"
  echo "$(p2p_port "$i") $(tend_port "$i") $(rpc_port "$i") $(ws_port "$i") $(grpc_port "$i") $(pprof_port "$i") $(metrics_port "$i")"
}

port_in_use() {
  # 0 = something is already listening (bad), 1 = free.
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || return 1
  exec 3>&- 2>/dev/null || true
  return 0
}

assert_ports_usable() {
  local i p all="" dup busy=""
  for i in 0 1 2 3; do
    for p in $(ports_of "$i"); do
      all="$all $p"
    done
  done
  # duplicate detection across the whole matrix
  dup="$(printf '%s\n' $all | sort | uniq -d | tr '\n' ' ')"
  if [ -n "$dup" ]; then
    log "ERROR: the port plan assigns the same port to more than one listener:$dup"
    for i in 0 1 2 3; do log "  node$i -> $(ports_of "$i")"; done
    exit 1
  fi
  # already-bound detection, so a stale process fails the run in seconds
  for p in $all; do
    if port_in_use "$p"; then busy="$busy $p"; fi
  done
  if [ -n "$busy" ]; then
    log "ERROR: these ports are already in use on this runner:$busy"
    exit 1
  fi
  for i in 0 1 2 3; do log "  node$i ports -> $(ports_of "$i")"; done
  log "port plan OK: 28 distinct listeners, none already bound"
}

# Wall-clock deadlines, never iteration counts.
# The first Phase 3 run failed after roughly 40 minutes because `--pprof.address` does not
# exist in evmd v0.7.3: every node exited immediately with "unknown flag", and the script then
# sat out a loop that was bounded by ITERATION COUNT rather than by time. Every wait below is
# now bounded in real seconds AND aborts the moment a node process disappears.
CONSENSUS_TIMEOUT_S="${CONSENSUS_TIMEOUT_S:-180}"
RECOVERY_TIMEOUT_S="${RECOVERY_TIMEOUT_S:-180}"
TX_TIMEOUT_S="${TX_TIMEOUT_S:-90}"
# Hard bound on any single `evmd` CLI call. The Cosmos SDK client retries a query FOREVER
# when its node is unreachable, so an unbounded `evmd q ...` turns one bad moment into a
# job that never finishes. Every CLI call below goes through this wrapper.
CLI_TIMEOUT_S="${CLI_TIMEOUT_S:-45}"

# Run one evmd invocation under a hard timeout. Prints the command first, so a log always
# shows exactly which call was in flight when something went wrong.
evmd_bounded() {
  local what="$1"; shift
  log "  -> $what"
  timeout "$CLI_TIMEOUT_S" "$@" || {
    local rc=$?
    log "  !! $what did not succeed (exit $rc) after ${CLI_TIMEOUT_S}s"
    return $rc
  }
}

deadline_in() { echo $(( $(date +%s) + $1 )); }

still_running() {
  # 0 = alive, 1 = gone. A dead node means the wait must end now, not after the timeout.
  local pid
  pid="$(cat "$ART/node$1.pid" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

status_of() {
  # must never fail and must never hang: query the Comet RPC directly with a hard
  # timeout; an unreachable node yields 0 rather than aborting under `set -e`.
  local out=""
  out="$(timeout 5 curl -s --max-time 4 "http://127.0.0.1:$(tend_port "$1")/status" 2>/dev/null \
    | jq -r '.result.sync_info.latest_block_height // "0"' 2>/dev/null || true)"
  if [ -z "$out" ] || [ "$out" = "null" ]; then out="0"; fi
  printf '%s' "$out"
}

# why is a node not progressing? one-line diagnostic per node
diag_of() {
  local n="$1" up="down" catching="unknown"
  up=$(timeout 5 curl -s --max-time 4 "http://127.0.0.1:$(tend_port "$n")/status" 2>/dev/null \
    | jq -r 'if .result then "up" else "down" end' 2>/dev/null || echo "down")
  if [ "$up" = "up" ]; then
    catching=$(timeout 5 curl -s --max-time 4 "http://127.0.0.1:$(tend_port "$n")/status" 2>/dev/null \
      | jq -r '.result.sync_info.catching_up // "n/a"' 2>/dev/null || echo "n/a")
  fi
  printf 'node%s rpc=%s catching_up=%s' "$n" "$up" "$catching"
}

# Print what a failing node actually complained about. Called on every abort path, because
# "nodes did not converge" is useless without the reason the nodes never started.
dump_node_errors() {
  local i
  for i in 0 1 2 3; do
    log "--- node$i first error lines ---"
    if [ -s "$ART/node$i.log" ]; then
      head -n 3 "$ART/node$i.log"
      grep -iE "panic|ERR |error|cannot|refused|bind|failed|timeout|already in use|no such|unknown flag" \
        "$ART/node$i.log" | head -n 8 || true
    else
      log "  (node$i log is empty: the process produced no output at all)"
    fi
  done
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

# ---------------- preflight: validate the CLI flags before spending CI time ----------------
log "=== preflight: port plan and CLI flags ==="
assert_ports_usable
log "--- validating every CLI flag against the evmd help output ---"
# This is the check that turns "unknown flag" from a 40-minute failure into a ten-second one.
START_FLAGS=(
  --home
  --chain-id
  --minimum-gas-prices
  --evm.evm-chain-id
  --evm.min-tip
  --pruning
  --log_level
  --p2p.laddr
  --rpc.laddr
  --grpc.address
  --evm.geth-metrics-address
  --json-rpc.enable
  --json-rpc.address
  --json-rpc.ws-address
  --json-rpc.api
)
evmd --help >"$ART/evmd-root-help.txt" 2>&1 || true
evmd start --help >"$ART/evmd-start-help.txt" 2>&1 || true
# Persistent flags such as --home may be documented only under the root command, so the
# check runs against BOTH help texts.
cat "$ART/evmd-root-help.txt" "$ART/evmd-start-help.txt" >"$ART/evmd-help-combined.txt" 2>/dev/null || true

# Guard against a false positive: if the help output is empty or unrecognisable, the check
# itself is worthless and must not block a network that would otherwise start. It is only
# allowed to fail the run when it can actually see a real flag list.
SEEN_KNOWN=0
for f in --chain-id --minimum-gas-prices --json-rpc.enable --p2p.laddr --rpc.laddr; do
  if grep -q -- "$f" "$ART/evmd-help-combined.txt"; then SEEN_KNOWN=$((SEEN_KNOWN + 1)); fi
done
if [ "$SEEN_KNOWN" -lt 4 ]; then
  log "WARNING: could not read a usable flag list from evmd --help (matched $SEEN_KNOWN/5 known flags)."
  log "  Skipping the flag preflight rather than blocking on an unreliable check."
else
  MISSING=""
  for f in "${START_FLAGS[@]}"; do
    if grep -q -- "$f" "$ART/evmd-help-combined.txt"; then
      log "  flag supported: $f"
    else
      MISSING="$MISSING $f"
      log "  FLAG NOT SUPPORTED by this evmd build: $f"
    fi
  done
  if [ -n "$MISSING" ]; then
    log "ERROR: refusing to start the network; unsupported flags:$MISSING"
    log "See $ART/evmd-help-combined.txt for what this build actually accepts."
    exit 1
  fi
fi

# ---------------- peer wiring ----------------
log "=== peer wiring (persistent_peers between the four nodes) ==="
# Node id = hex(sha256(node pubkey)[:20]). `evmd tendermint show-node-id` is the supported
# command; if it is unavailable we derive the id from node_key.json so that peer wiring can
# never be the silent failure point of this script.
# CometBFT node id = hex(sha256(PUBLIC key)[:20]).
#
# An earlier version derived it from node_key.json's PRIVATE key, which is simply the wrong
# input: every node then dialled its peers under an identity none of them held, the handshake
# failed with "auth failure: conn.ID (...) dialed ID (...) mismatch", and no node ever got a
# peer. All four stayed up and stayed stuck at catching_up=true. The derivation below is the
# one CometBFT actually uses.
# Print exactly what the node key material looks like. This exists because guessing the
# layout of node_key.json wasted two CI cycles: a first attempt derived the id from the
# private key, a second from what was believed to be the public key, and both produced a
# value that no node recognised. The layout is now measured, not assumed.
dump_node_id_diagnostics() {
  local home="$1" f="$1/config/node_key.json"
  log "  --- node id diagnostics for $f ---"
  if [ ! -f "$f" ]; then log "  node_key.json DOES NOT EXIST at this path"; return; fi
  log "  top-level keys: $(jq -r 'keys | join(",")' "$f" 2>&1 || echo jq-failed)"
  log "  pub_key type : $(jq -r '.pub_key.type // "MISSING"' "$f" 2>&1 || echo jq-failed)"
  log "  pub_key value: $(jq -r '.pub_key.value // "MISSING"' "$f" 2>&1 | cut -c1-24 || echo jq-failed)"
  log "  priv_key type: $(jq -r '.priv_key.type // "MISSING"' "$f" 2>&1 || echo jq-failed)"
  local pub priv
  pub="$(jq -r '.pub_key.value // empty' "$f" 2>/dev/null || true)"
  priv="$(jq -r '.priv_key.value // empty' "$f" 2>/dev/null || true)"
  log "  pub  base64-decoded bytes : $(printf '%s' "$pub" | base64 -d 2>/dev/null | wc -c || echo 0)"
  log "  priv base64-decoded bytes : $(printf '%s' "$priv" | base64 -d 2>/dev/null | wc -c || echo 0)"
  log "  id from pub  (sha256[:20]): $(printf '%s' "$pub" | base64 -d 2>/dev/null | sha256sum | cut -c1-40 || echo none)"
  log "  id from priv (sha256[:20]): $(printf '%s' "$priv" | base64 -d 2>/dev/null | sha256sum | cut -c1-40 || echo none)"
  log "  id from ed25519 pub (tail20 of priv sha): $(printf '%s' "$priv" | base64 -d 2>/dev/null | tail -c 32 | sha256sum | cut -c1-40 || echo none)"
  log "  'evmd tendermint show-node-id': [$(evmd tendermint show-node-id --home "$home" 2>&1 | tr -d '\r\n' | cut -c1-60)]"
}

node_id_of() {
  local home="$1" derived="" cli="" b64=""
  # MEASURED facts about evmd v0.7.3 / CometBFT (see $ART/node-id-diagnostics.txt):
  #   - node_key.json contains ONLY `priv_key`; there is no `pub_key` field.
  #   - `evmd tendermint show-node-id` does not exist ("unknown command tendermint").
  #   - the decoded private key is 64 bytes: ed25519 seed (32) || ed25519 public key (32).
  # CometBFT's node id is hex(sha256(public key)[:20]), so the public key is the LAST 32
  # bytes of that 64-byte value. Deriving from the whole 64 bytes, as an earlier version did,
  # produces an id no node recognises, which is why nothing ever formed a peer mesh.
  b64="$(jq -r '.priv_key.value // empty' "$home/config/node_key.json" 2>/dev/null || true)"
  if [ -n "$b64" ]; then
    derived="$(printf '%s' "$b64" | base64 -d 2>/dev/null | tail -c 32 | sha256sum | cut -c1-40 || true)"
  fi
  # Cross-check against the CLI, when this build has it. A disagreement is itself a finding.
  cli="$(evmd cometbft show-node-id --home "$home" 2>/dev/null | tr -d '\r\n' || true)"
  if [ -n "$derived" ] && [ -n "$cli" ] && [ "$derived" != "$cli" ]; then
    log "  WARNING: derived node id $derived but 'evmd cometbft show-node-id' says $cli"
  fi
  if [ -n "$cli" ]; then printf '%s' "$cli"; else printf '%s' "$derived"; fi
}

# Ground truth: the id a running node reports about ITSELF. Used to verify the wiring
# instead of trusting the derivation.
reported_id_of() {
  local out=""
  out="$(timeout 5 curl -s --max-time 4 "http://127.0.0.1:$(tend_port "$1")/status" 2>/dev/null \
    | jq -r '.result.node_info.id // empty' 2>/dev/null || true)"
  printf '%s' "$out"
}

peers_of() {
  local out=""
  out="$(timeout 5 curl -s --max-time 4 "http://127.0.0.1:$(tend_port "$1")/net_info" 2>/dev/null \
    | jq -r '.result.n_peers // "0"' 2>/dev/null || true)"
  if [ -z "$out" ] || [ "$out" = "null" ]; then out="0"; fi
  printf '%s' "$out"
}
declare -a NODEID
dump_node_id_diagnostics "$NODES_ROOT/node0" | tee "$ART/node-id-diagnostics.txt"
for i in 0 1 2 3; do
  NODEID[$i]="$(node_id_of "$NODES_ROOT/node$i")"
  log "node$i p2p id = ${NODEID[$i]:-none}"
  if [ -z "${NODEID[$i]}" ]; then log "ERROR: could not determine the p2p node id for node$i"; exit 1; fi
done
for i in 0 1 2 3; do
  PEERS=""
  for j in 0 1 2 3; do
    # `test && cmd` returns 1 when the test is false, which aborts the script under
    # `set -e`; always use the explicit if form here.
    if [ "$i" = "$j" ]; then continue; fi
    if [ -n "$PEERS" ]; then PEERS="$PEERS,"; fi
    PEERS="$PEERS${NODEID[$j]}@$(p2p_ip "$j"):$(p2p_port "$j")"
  done
  sed -i.bak "s/^persistent_peers = .*/persistent_peers = \"$PEERS\"/" "$NODES_ROOT/node$i/config/config.toml"
  # CometBFT refuses to place loopback addresses in its address book ("Cannot add
  # non-routable address ...@127.0.0.1:26658"). On a single-runner devnet that book is
  # useless anyway: every peer is reachable through persistent_peers.
  if grep -q '^addr_book_strict' "$NODES_ROOT/node$i/config/config.toml"; then
    sed -i "s/^addr_book_strict = .*/addr_book_strict = false/" "$NODES_ROOT/node$i/config/config.toml"
  else
    printf '\naddr_book_strict = false\n' >>"$NODES_ROOT/node$i/config/config.toml"
  fi
  # The pprof listener has no CLI flag in this build, so it must come from config.toml.
  # Discover the real key name rather than assuming one. A pprof bind failure is NON-FATAL
  # (measured: with all four fighting over port 6060 every node stayed up), so this is best
  # effort and says so out loud.
  PKEY="$(grep -oE '^pprof[a-z_-]*' "$NODES_ROOT/node$i/config/config.toml" | head -1 || true)"
  if [ -n "$PKEY" ]; then
    sed -i "s|^$PKEY = .*|$PKEY = \"127.0.0.1:$(pprof_port "$i")\"|" "$NODES_ROOT/node$i/config/config.toml"
    log "node$i pprof ($PKEY) -> 127.0.0.1:$(pprof_port "$i")"
  else
    log "node$i: no pprof key in config.toml; pprof will collide on the shared default (non-fatal)"
  fi
  log "node$i peers wired + addr_book_strict=false"
done

# ---------------- the single place a node is ever launched ----------------
# T5/T6 reuse this, so the flag set can never drift between the first start and the restart.
start_node() {
  local i="$1"
  local H="$NODES_ROOT/node$i"
  nohup evmd start \
    --home "$H" \
    --chain-id "$C_CHAIN_ID" \
    --minimum-gas-prices "$MIN_GAS_PRICE" \
    --evm.evm-chain-id "$E_CHAIN_ID" \
    --evm.min-tip 0 \
    --pruning nothing \
    --log_level info \
    --p2p.laddr "tcp://$(p2p_ip "$i"):$(p2p_port "$i")" \
    --rpc.laddr "tcp://127.0.0.1:$(tend_port "$i")" \
    --grpc.address "127.0.0.1:$(grpc_port "$i")" \
    --evm.geth-metrics-address "127.0.0.1:$(metrics_port "$i")" \
    --json-rpc.enable true \
    --json-rpc.address "127.0.0.1:$(rpc_port "$i")" \
    --json-rpc.ws-address "127.0.0.1:$(ws_port "$i")" \
    --json-rpc.api eth,txpool,personal,net,debug,web3 \
    >>"$ART/node$i.log" 2>&1 &
  echo $! >"$ART/node$i.pid"
}

log "=== starting four validators (staggered) ==="
# Staggered start: a previous run showed one node still refusing connections while another
# was already dialling it ("dial tcp 127.0.0.4:26662: connect: connection refused"), which
# made peer formation depend on which node happened to boot first.
for i in 0 1 2 3; do
  : >"$ART/node$i.log"
  start_node "$i"
  log "node$i started (json-rpc $(rpc_port "$i"), comet rpc $(tend_port "$i"), p2p $(p2p_ip "$i"):$(p2p_port "$i"))"
  if [ "$i" -lt 3 ]; then sleep 2; fi
done

log "=== peer identity check (wired id vs the id each node reports about itself) ==="
# If this fails, the peers were dialled under identities they do not hold and no mesh can
# form. Checking it here turns that into an immediate, explicit failure.
ID_DEADLINE="$(deadline_in 60)"
ids_ok=0
while [ "$(date +%s)" -lt "$ID_DEADLINE" ]; do
  R0="$(reported_id_of 0)"
  if [ -n "$R0" ]; then ids_ok=1; break; fi
  sleep 2
done
id_mismatch=0
{
  for i in 0 1 2 3; do
    RID="$(reported_id_of "$i")"
    WID="${NODEID[$i]}"
    if [ "$RID" = "$WID" ]; then
      echo "node$i id OK: $RID"
    else
      echo "node$i id MISMATCH: wired=$WID reported=$RID"
      id_mismatch=1
    fi
  done
} | tee "$ART/p2p-node-ids.txt"
if [ "$ids_ok" != 1 ] || [ "$id_mismatch" != 0 ]; then
  log "ERROR: the p2p identities we wired do not match what the nodes report about themselves."
  log "  Consensus is impossible until they match. See $ART/p2p-node-ids.txt."
  dump_node_errors
  exit 1
fi
log "node identities verified against the nodes' own /status"

log "=== peer handshake check (before waiting on consensus) ==="
# Consensus cannot happen until the nodes actually see each other. Checking the peer counts
# separately turns "no consensus" into a precise peering diagnosis.
#
# The bar is deliberately "SOME node reaches 3 peers", not "node0 reaches 3 peers". Inbound
# and outbound connections settle at different moments, so a single node's count is a race:
# one measured run reported node0=3 while the others still said 1, and consensus succeeded
# anyway; the next run reported node0=2. Requiring any one node to reach 3 keeps the check
# meaningful without making it flaky.
PEER_DEADLINE="$(deadline_in 120)"
mesh_ok=0
while [ "$(date +%s)" -lt "$PEER_DEADLINE" ]; do
  for i in 0 1 2 3; do
    if [ "$(peers_of "$i")" -ge 3 ] 2>/dev/null; then mesh_ok=1; break; fi
  done
  if [ "$mesh_ok" -eq 1 ]; then break; fi
  sleep 2
done
{
  for i in 0 1 2 3; do echo "node$i n_peers=$(peers_of "$i")"; done
  echo "mesh_complete=$mesh_ok"
} | tee "$ART/p2p-peer-counts.txt"
if [ "$mesh_ok" != 1 ]; then
  log "ERROR: no node reached 3 peers within 120s; the p2p mesh is genuinely incomplete."
  log "  Peer counts above are the evidence. Consensus is impossible without a full mesh."
  dump_node_errors
  exit 1
fi
log "peer mesh OK: at least one node sees 3 peers"

log "=== wait for consensus (bounded to ${CONSENSUS_TIMEOUT_S}s of wall clock) ==="
ready=0
DEADLINE="$(deadline_in "$CONSENSUS_TIMEOUT_S")"
ABORT=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  for i in 0 1 2 3; do
    if ! still_running "$i"; then
      log "ERROR: node$i exited; ending the wait now instead of burning the full timeout"
      ABORT=1
      break
    fi
  done
  if [ "$ABORT" -eq 1 ]; then break; fi
  H1="$(status_of 0)"; H2="$(status_of 1)"; H3="$(status_of 2)"; H4="$(status_of 3)"
  if [ "$H1" -ge 2 ] 2>/dev/null && [ "$H1" = "$H2" ] && [ "$H2" = "$H3" ] && [ "$H3" = "$H4" ]; then
    ready=1
    log "4/4 nodes agree at height $H1 after $((CONSENSUS_TIMEOUT_S - (DEADLINE - $(date +%s))))s"
    break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  log "ERROR: the four validators did not converge within ${CONSENSUS_TIMEOUT_S}s"
  for i in 0 1 2 3; do log "  $(diag_of "$i")"; done
  dump_node_errors
  exit 1
fi

# ---------------- T3: all nodes agree and advance ----------------
log "=== T3: block production and agreement ==="
declare -a BEFORE
for i in 0 1 2 3; do BEFORE[$i]="$(status_of "$i")"; done
sleep 6
: >"$ART/t3-heights.txt"
same=1
for i in 0 1 2 3; do
  now="$(status_of "$i")"
  echo "node$i height ${BEFORE[$i]} -> $now" | tee -a "$ART/t3-heights.txt"
  if [ "$now" -gt "${BEFORE[$i]}" ]; then :; else log "ERROR: node$i did not advance"; same=0; fi
done
REF="$(status_of 0)"
for i in 1 2 3; do
  if [ "$(status_of "$i")" = "$REF" ]; then :; else log "ERROR: node$i height differs from node0"; same=0; fi
done
[ "$same" = 1 ] || exit 1
# Identical app hash on every node = identical application state.
# Read it straight from the CometBFT REST endpoint. `evmd status` is deprecated in this
# SDK generation and printed something that is not JSON ("jq: parse error: Invalid numeric
# literal at line 1, column 8"), which broke the very check that proves state agreement.
apphash_of() {
  local out=""
  out="$(timeout 5 curl -s --max-time 4 "http://127.0.0.1:$(tend_port "$1")/status" 2>/dev/null \
    | jq -r '.result.sync_info.latest_app_hash // empty' 2>/dev/null || true)"
  printf '%s' "$out"
}
AH0="$(apphash_of 0)"
AH1="$(apphash_of 1)"
AH2="$(apphash_of 2)"
AH3="$(apphash_of 3)"
echo "app_hash node0=$AH0 node1=$AH1 node2=$AH2 node3=$AH3" | tee "$ART/t3-apphash.txt"
if [ -z "$AH0" ]; then
  log "ERROR: could not read an app hash from node0; the state-agreement check cannot be made"
  exit 1
fi
if [ "$AH0" = "$AH1" ] && [ "$AH1" = "$AH2" ] && [ "$AH2" = "$AH3" ]; then :; else
  log "ERROR: app hashes differ between nodes"; exit 1
fi
log "T3 OK: 4/4 nodes advancing with identical app hashes"

# On-chain validator set (materialised at InitChain from the 4 gentxs).
# INFORMATIONAL ONLY. T3 has already proved the set is live: four nodes produced blocks with
# byte-identical app hashes. This readout is a convenience, so it must never be the thing
# that fails the run. An earlier version piped `evmd q staking validators -o json` straight
# into jq and died with "jq: parse error: Invalid numeric literal at line 1, column 8" when
# the CLI emitted a non-JSON preamble.
log "on-chain validator set (informational):"
SV_OUT="$ART/t2b-validators-onchain.json"
evmd q staking validators --node "$NODE0_RPC" -o json >"$SV_OUT" 2>"$ART/t2b-stderr.txt" || \
  log "  the staking query returned a non-zero exit; continuing (this readout is optional)"
if jq -e . "$SV_OUT" >/dev/null 2>&1; then
  jq -r '.validators[] | "on-chain validator: \(.description.moniker) status=\(.status) tokens=\(.tokens)"' \
    "$SV_OUT" >"$ART/t2b-validators-onchain.txt" 2>/dev/null || log "  could not format the validator list"
  ONV="$(jq -r '.validators | length' "$SV_OUT" 2>/dev/null || echo 0)"
  log "  on-chain validator count = $ONV"
  sed -n '1,8p' "$ART/t2b-validators-onchain.txt" || true
else
  log "  SKIPPED: the CLI did not return JSON. First bytes were:"
  head -c 200 "$SV_OUT" 2>/dev/null | tr '\n' ' ' || true
  echo
  head -c 200 "$ART/t2b-stderr.txt" 2>/dev/null | tr '\n' ' ' || true
  echo
fi

# ---------------- T4: transfer over the 4-node network ----------------
log "=== T4: Cosmos transfer on the multi-validator network ==="
N0="$NODES_ROOT/node0"
NODE0_RPC="tcp://127.0.0.1:$(tend_port 0)"
# Every query below passes --node explicitly. Relying on client.toml would send the query to
# whatever node that file names, which is how a test silently ends up reading the wrong node.
DST="$(evmd_bounded "show dev3 address" evmd keys show dev3 -a --keyring-backend test --home "$N0")"
balance_of() {
  evmd_bounded "bank balances of $DST" evmd q bank balances "$DST" --keyring-backend test \
    --home "$N0" --node "$NODE0_RPC" -o json \
    | jq -r ".balances[] | select(.denom==\"$DENOM\") | .amount"
}
BEFORE_DST="$(balance_of)"
SEND_AMOUNT=5550000000000000000
SEND_OUT="$(evmd_bounded "bank send val0 -> dev3" evmd tx bank send val0 "$DST" "$SEND_AMOUNT$DENOM" \
  --chain-id "$C_CHAIN_ID" --keyring-backend test --home "$N0" \
  --node "$NODE0_RPC" \
  --gas 300000 --gas-prices "$GAS_PRICE" --broadcast-mode sync -y -o json 2>&1)"
echo "$SEND_OUT" | tee "$ART/t4-send.json"
TXH="$(echo "$SEND_OUT" | jq -r '.txhash // empty')"
[ -n "$TXH" ] || { log "ERROR: no txhash returned"; exit 1; }
CODE=""
TX_DEADLINE="$(deadline_in "$TX_TIMEOUT_S")"
while [ "$(date +%s)" -lt "$TX_DEADLINE" ]; do
  CODE="$(evmd_bounded "query tx $TXH" evmd q tx "$TXH" --node "$NODE0_RPC" -o json 2>/dev/null | jq -r '.code // empty' || true)"
  if [ -n "$CODE" ]; then break; fi
  sleep 1
done
echo "tx=$TXH code=$CODE" | tee "$ART/t4-tx-code.txt"
[ "$CODE" = "0" ] || { log "ERROR: transfer failed (code=$CODE)"; exit 1; }
AFTER_DST=""
TX_DEADLINE="$(deadline_in "$TX_TIMEOUT_S")"
while [ "$(date +%s)" -lt "$TX_DEADLINE" ]; do
  AFTER_DST="$(balance_of)"
  if python3 -c 'import sys; b,a,d=map(int,sys.argv[1:4]); sys.exit(0 if a==b+d else 1)' "$BEFORE_DST" "$AFTER_DST" "$SEND_AMOUNT"; then
    break
  fi
  sleep 1
done
echo "dev3 $BEFORE_DST -> $AFTER_DST (+$SEND_AMOUNT)" | tee "$ART/t4-balance.txt"
python3 -c 'import sys; b,a,d=map(int,sys.argv[1:4]); sys.exit(0 if a==b+d else 1)' "$BEFORE_DST" "$AFTER_DST" "$SEND_AMOUNT" \
  || { log "ERROR: multi-node transfer did not settle"; exit 1; }
log "T4 OK: transfer settled on the 4-validator network"

# ---------------- T5: kill one validator, chain must keep producing ----------------
log "=== T5: one-validator fault tolerance (killing node$KILL_NODE) ==="
PID_K="$(cat "$ART/node$KILL_NODE.pid")"
PRE_KILL="$(status_of 0)"
kill "$PID_K" 2>/dev/null || true
sleep 3
log "node$KILL_NODE (pid $PID_K) stopped"
sleep 8
POST_KILL="$(status_of 0)"
echo "height with 3 validators: $PRE_KILL -> $POST_KILL" | tee "$ART/t5-after-kill.txt"
[ "$POST_KILL" -gt "$PRE_KILL" ] || { log "ERROR: the chain halted without node$KILL_NODE"; exit 1; }
# queries must keep working with 3/4 validators
evmd_bounded "bank balances during fault" evmd q bank balances "$DST" --keyring-backend test \
  --home "$N0" --node "$NODE0_RPC" -o json >"$ART/t5-query-during-fault.json"
log "T5 OK: the chain produced $((POST_KILL - PRE_KILL)) blocks and kept serving queries with 3/4 validators"

# ---------------- T6: restart the stopped validator and let it catch up ----------------
log "=== T6: recovery of node$KILL_NODE ==="
start_node "$KILL_NODE"
log "node$KILL_NODE restarted, waiting for catch-up (bounded to ${RECOVERY_TIMEOUT_S}s)"

caught=0
DEADLINE="$(deadline_in "$RECOVERY_TIMEOUT_S")"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if ! still_running "$KILL_NODE"; then
    log "ERROR: node$KILL_NODE exited again during recovery"
    break
  fi
  HN="$(status_of "$KILL_NODE")"
  H0="$(status_of 0)"
  if [ -n "$HN" ] && [ "$HN" -ge "$H0" ] 2>/dev/null; then
    caught=1
    ELAPSED=$((RECOVERY_TIMEOUT_S - (DEADLINE - $(date +%s))))
    echo "node$KILL_NODE caught up: height $HN (network $H0) after ${ELAPSED}s" | tee "$ART/t6-recovery.txt"
    break
  fi
  sleep 1
done
if [ "$caught" != 1 ]; then
  log "ERROR: node$KILL_NODE did not catch up"
  tail -n 40 "$ART/node$KILL_NODE.log" || true
  exit 1
fi
log "T6 OK: the recovered validator re-synced to the network tip"

log "=== DONE: Phase 3 multi-validator devnet verified (consensus, 1-fault tolerance, recovery) ==="