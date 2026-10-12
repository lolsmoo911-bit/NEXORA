#!/usr/bin/env bash
# NEXORA — stop the local network started by start-local-node.sh.
#
# Graceful first, then forced. A validator killed without warning can leave a partial block
# in the store, which the next start has to recover from; CometBFT handles it, but it costs
# time and looks alarming in the log.
set -euo pipefail
WORK="${WORK:-$HOME/nexora-testnet}"

shopt -s nullglob
PIDS=("$WORK"/node*.pid)
[ "${#PIDS[@]}" -gt 0 ] || { echo "no pid files in $WORK — nothing started by this script is running" >&2; exit 0; }

GRACEFUL=()
for f in "${PIDS[@]}"; do
  PID=$(cat "$f")
  if kill -0 "$PID" 2>/dev/null; then
    echo "stopping pid $PID ($(basename "$f" .pid))" >&2
    kill "$PID" 2>/dev/null || true
    GRACEFUL+=("$PID")
  fi
  rm -f "$f"
done

[ "${#GRACEFUL[@]}" -gt 0 ] && sleep 5

FORCED=0
for PID in "${GRACEFUL[@]}"; do
  if kill -0 "$PID" 2>/dev/null; then
    echo "pid $PID ignored SIGTERM; forcing" >&2
    kill -9 "$PID" 2>/dev/null || true
    FORCED=$((FORCED + 1))
  fi
done

if [ "$FORCED" -gt 0 ]; then
  echo "note: $FORCED validator(s) needed SIGKILL; check $WORK/node*.log" >&2
fi
echo "stopped. state preserved in $WORK — restarting resumes from this height" >&2
