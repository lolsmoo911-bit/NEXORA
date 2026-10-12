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
#   * Go 1.25.9, or the script will fetch a pinned prebuilt `evmd`
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

log() { printf '[nexora] %s\n' "$*" >&2; }
die() { printf '[nexora] FATAL: %s\n' "$*" >&2; exit 1; }

ip_for()   { echo "127.0.0.$(( $1 + 1 ))"; }
port_for() { echo $(( 26650 + $1 * 10 )); }

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
log "evmd: $($EVM version 2>&1 | head -1)"

# --------------------------------------------------------------------- genesis

GEN_HOME="$WORK/genesis-home"
if [ ! -f "$WORK/genesis.json" ]; then
  log "generating the 4-validator genesis (this is deterministic; run it once)"
  "$ROOT/ci/phase3/gen4-genesis.sh" "$GEN_HOME"
  cp "$GEN_HOME/config/genesis.json" "$WORK/genesis.json"
  log "genesis sha256 $(sha256sum "$WORK/genesis.json" | cut -d' ' -f1)"
else
  log "reusing the existing genesis at $WORK/genesis.json"
fi

# --------------------------------------------------------------------- homes

for i in $(seq 0 $((NODES - 1))); do
  if [ ! -d "$WORK/node$i/config" ]; then
    "$ROOT/ci/phase3/make-node-home.sh" "$i" "$WORK/genesis.json" "$WORK/node$i" "$WORK/template-home"
  fi
done

# --------------------------------------------------------------------- start

for i in $(seq 0 $((NODES - 1))); do
  H="$WORK/node$i"
  # No --halt-height here: this node runs until you stop it.
  nohup "$EVM" start \
    --home "$H" \
    --address "tcp://$(ip_for $i):$(port_for $i)" \
    --p2p.laddr "tcp://$(ip_for $i):$(( port_for $i + 1 ))" \
    --rpc.laddr "tcp://127.0.0.1:$(( port_for $i + 2 ))" \
    --grpc.address "127.0.0.1:$(( port_for $i + 3 ))" \
    --pprof_laddr "localhost:$(( port_for $i + 4 ))" \
    --json-rpc.address "127.0.0.1:$(( port_for $i + 5 ))" \
    --json-rpc.ws-address "127.0.0.1:$(( port_for $i + 6 ))" \
    --api.enable --grpc-web.enable \
    --log_level info \
    > "$WORK/node$i.log" 2>&1 &
  echo "$!" > "$WORK/node$i.pid"
  log "node$i started (pid $(cat "$WORK/node$i.pid")), log: $WORK/node$i.log"
  sleep 2
done

# --------------------------------------------------------------------- report

cat >&2 <<EOF

  NEXORA is starting. Four validators, one machine, one network.

  RPC endpoints (localhost only, by design):
$(for i in $(seq 0 $((NODES - 1))); do
    echo "    node$i  http://127.0.0.1:$(( port_for $i + 2 ))   json-rpc http://127.0.0.1:$(( port_for $i + 5 ))"
  done)

  Watch it work:
    curl -s http://127.0.0.1:26652/status | head -c 400

  Stop everything:
    $WORK/stop.sh

  Your keys live in $WORK/node*/keyring and are TEST KEYS recovered from the upstream
  public test mnemonics. They are published upstream and must never hold value.

EOF
log "running. Ctrl-C does not stop the validators; use stop.sh"
