#!/usr/bin/env bash
# NEXORA — start a REAL node on a machine you control.
#
# This is the difference between a testnet that advances once an hour inside GitHub Actions
# and a network you can actually point a wallet at.
#
# WHAT YOU GET
# ------------
# Four validators, real consensus, real P2P, running until you stop them. Your machine is
# the infrastructure; there is no server bill, no account, and no third party.
#
# WHAT YOU NEED
# -------------
#   * Linux or macOS (WSL2 counts), 4 GB RAM free, ~2 GB disk
#   * Go 1.25.9, or the script will build evmd from a pinned upstream checkout
#   * 15 minutes for the first build, ~40 MB/yr after
#
# WHAT THIS IS NOT
# ----------------
# Not a public network. Your RPC on 127.0.0.1 is not reachable from the internet, and that
# is deliberate. Opening a port is a security decision with a real threat model, and it is
# not one an agent should make for you.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${WORK:-$HOME/nexora-testnet}"
EVM="${EVM:-$WORK/evmd}"
UPSTREAM_REF="v0.7.3"
UPSTREAM_SHA="c3ae9067a7eadcdea55a5192226916deb44c71c4"
NODES=4

export PARAMS_FILE="${PARAMS_FILE:-$ROOT/chain/nexora-devnet.json}"
export COSMOS_EVM_DIR="${COSMOS_EVM_DIR:-$WORK/cosmos-evm}"

GENESIS_SH="$ROOT/ci/phase3/gen4-genesis.sh"
HOME_SH="$ROOT/ci/phase3/make-node-home.sh"

log() { printf '[nexora] %s\n' "$*" >&2; }
die() { printf '[nexora] FATAL: %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------- port plan
#
# Identical to the plan ci/testnet/run-epoch.sh uses, because that plan is the one measured
# to work with four validators on one host. p2p and the CometBFT RPC interleave from 26656;
# json-rpc, grpc, pprof and metrics each occupy their own band so no two nodes contend.
#
# Always call these as `$(f "$i")`. Writing `$(( f "$i" + 2 ))` is arithmetic expansion, which
# does not evaluate a function call; bash reports that as an unbound variable named after the
# function, which reads like a missing variable rather than a typo.
ip_for()       { echo "127.0.0.$(( 1 + $1 ))"; }
p2p_port()     { echo $(( 26656 + 2 * $1 )); }
tend_port()    { echo $(( 26657 + 2 * $1 )); }
rpc_port()     { echo $(( 8545 + $1 )); }
ws_port()      { echo $(( 8645 + $1 )); }
grpc_port()    { echo $(( 9090 + $1 )); }
pprof_port()   { echo $(( 6060 + $1 )); }
metrics_port() { echo $(( 26670 + $1 )); }

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
      log "ERROR: port $p is already bound on this machine"
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

json_get() {
  python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
for key in sys.argv[2].split('.'):
    d = d[key]
print(d)
" "$@"
}

command -v jq   >/dev/null 2>&1 || die "jq is required (apt install jq / brew install jq)"
command -v curl >/dev/null 2>&1 || die "curl is required"

mkdir -p "$WORK"

# --------------------------------------------------------------------- upstream

if [ ! -d "$COSMOS_EVM_DIR/.git" ]; then
  log "cloning upstream cosmos/evm $UPSTREAM_REF"
  git clone --depth 1 --branch "$UPSTREAM_REF" https://github.com/cosmos/evm.git "$COSMOS_EVM_DIR"
fi

ACTUAL=$(git -C "$COSMOS_EVM_DIR" rev-parse HEAD)
[ "$ACTUAL" = "$UPSTREAM_SHA" ] || die "upstream is $ACTUAL, expected $UPSTREAM_SHA. Refusing to build a chain from unexpected source."
log "upstream verified at $ACTUAL"

if [ ! -x "$EVM" ]; then
  command -v go >/dev/null 2>&1 || die "Go 1.25.9 is required to build evmd (https://go.dev/dl/)"
  log "building evmd (first run takes a few minutes)"
  ( cd "$COSMOS_EVM_DIR" && make build >/dev/null )
  cp "$(command -v evmd 2>/dev/null || echo "$COSMOS_EVM_DIR/build/evmd")" "$EVM"
fi
log "evmd: $("$EVM" version 2>&1 | head -1)"

# --------------------------------------------------------------------- genesis

# gen4-genesis.sh takes TWO arguments: the home to build, and a directory for its artifacts.
# Passing one fails with "2: output dir required".
GEN_HOME="$WORK/genesis-home"
GEN_ARTIFACTS="$WORK/genesis-artifacts"
if [ ! -f "$WORK/genesis.json" ]; then
  log "generating the 4-validator genesis (this is deterministic; run it once)"
  bash "$GENESIS_SH" "$GEN_HOME" "$GEN_ARTIFACTS" || die "genesis generation failed"
  cp "$GEN_HOME/config/genesis.json" "$WORK/genesis.json"
  log "genesis sha256 $(sha256sum "$WORK/genesis.json" | cut -d' ' -f1)"
else
  log "reusing the existing genesis at $WORK/genesis.json"
fi

# --------------------------------------------------------------------- node homes

# The template is the fully-initialised genesis home, which is what make-node-home.sh copies
# config.toml and app.toml from. A template path that does not exist produces a node home with
# no config at all, which fails much later and much less legibly.
for i in $(seq 0 $((NODES - 1))); do
  if [ ! -d "$WORK/node$i/config" ]; then
    bash "$HOME_SH" "$i" "$WORK/genesis.json" "$WORK/node$i" "$GEN_HOME" \
      || die "could not provision node$i"
  fi
done

# --------------------------------------------------------------------- wire the mesh
#
# THIS IS NOT OPTIONAL. Four validators that are not told about each other are four
# single-validator chains: they each start at height 1, propose alone, and never see a vote
# they agree with, so height never advances and nothing is committed. CometBFT has no peer
# discovery on loopback ("Cannot add non-routable address"), so the address book is disabled
# and every peer is named explicitly.
#
# The p2p listen address is set with `--p2p.laddr`, NOT `--address`. Both exist in this build:
# `--address` (server/flags/flags.go: Address = "address") is the ABCI/application listener and
# defaults to tcp://0.0.0.0:26658. The CometBFT p2p listener reads `p2p.laddr` from config.toml
# and otherwise keeps its default of tcp://0.0.0.0:26656 — so every node given only `--address`
# tries to bind 0.0.0.0:26656 and the second one dies with "address already in use", which reads
# like a port conflict rather than a flag that was never the one you thought it was.
#
# `--pprof_laddr` is not a flag in this build: it appears nowhere in the source, and passing it
# makes `evmd start` print its whole help text and exit. The pprof listener is a config.toml key.

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
  # Several validators on one machine legitimately share the host's address space; CometBFT
  # drops such peers by default, which surfaces as a handshake that dies mid-way.
  if grep -q '^allow_duplicate_ip' "$CFG"; then
    sed -i "s/^allow_duplicate_ip = .*/allow_duplicate_ip = true/" "$CFG"
  else
    printf 'allow_duplicate_ip = true\n' >> "$CFG"
  fi
  # The pprof listener has no CLI flag in this build. Discover the real key rather than
  # assuming one. A pprof bind failure is non-fatal, so this is best effort and says so.
  PKEY="$(grep -oE '^pprof[a-z_-]*' "$CFG" | head -1 || true)"
  if [ -n "$PKEY" ]; then
    sed -i "s/^${PKEY} = .*/${PKEY} = \"127.0.0.1:$(pprof_port "$i")\"/" "$CFG" || true
  fi
  log "node$i wired: external=$EXT peers=${PEERS:0:40}..."
done

# --------------------------------------------------------------------- start

assert_port_plan

for i in $(seq 0 $((NODES - 1))); do
  H="$WORK/node$i"
  # No --halt-height here: this node runs until you stop it.
  nohup "$EVM" start \
    --home "$H" \
    --chain-id "$(json_get "$WORK/genesis.json" chain_id)" \
    --minimum-gas-prices "$(json_get "$PARAMS_FILE" 'fees.min_gas_price')" \
    --evm.evm-chain-id "$(json_get "$PARAMS_FILE" evm_chain_id)" \
    --evm.min-tip 0 \
    --pruning nothing \
    --log_level info \
    --p2p.laddr "tcp://$(ip_for "$i"):$(p2p_port "$i")" \
    --rpc.laddr "tcp://127.0.0.1:$(tend_port "$i")" \
    --grpc.address "127.0.0.1:$(grpc_port "$i")" \
    --evm.geth-metrics-address "127.0.0.1:$(metrics_port "$i")" \
    --json-rpc.enable true \
    --json-rpc.address "127.0.0.1:$(rpc_port "$i")" \
    --json-rpc.ws-address "127.0.0.1:$(ws_port "$i")" \
    --json-rpc.api eth,txpool,personal,net,debug,web3 \
    --api.enable --grpc-web.enable \
    > "$WORK/node$i.log" 2>&1 &
  PID=$!
  echo "$PID" > "$WORK/node$i.pid"
  sleep 2
  # A rejected flag or a failed bind makes evmd exit within the first second, and its log is
  # then 150 lines of flag documentation with the cause nowhere in it. Checking liveness here
  # turns "the chain silently never advanced" into one readable line.
  if ! kill -0 "$PID" 2>/dev/null; then
    tail -20 "$WORK/node$i.log" >&2
    die "node$i exited immediately (log: $WORK/node$i.log)"
  fi
  log "node$i started (pid $PID), log: $WORK/node$i.log"
done

# --------------------------------------------------------------------- report

cat >&2 <<EOF

  NEXORA is starting. Four validators, one machine, one network.

  RPC endpoints (localhost only, by design):
$(for i in $(seq 0 $((NODES - 1))); do
    echo "    node$i  comet http://127.0.0.1:$(tend_port "$i")   json-rpc http://127.0.0.1:$(rpc_port "$i")"
  done)

  Watch it work:
    curl -s http://127.0.0.1:$(tend_port 0)/status | head -c 400

  If height stays at 0, the mesh did not form. Read this first:
    grep -iE "peer|dial|handshake" $WORK/node0.log | head -20

  Stop everything:
    bash $ROOT/ci/testnet/stop.sh

  Your keys live in $WORK/node*/keyring and are TEST KEYS recovered from the upstream
  public test mnemonics. They are published upstream and must never hold value.

EOF
log "running. Ctrl-C does not stop the validators; use stop.sh"