#!/bin/bash
# BlockScout price sync loop: one run at a time (flock prevents overlap when a run
# outlasts the interval), with duration logging for observability.
cd /home/runner/workspace
LOCK=/home/runner/workspace/nexora-plan/price_sync.lock
while true; do
  (
    if ! flock -n 9; then
      echo "$(date -Is) previous sync still running — skipping this cycle" >> nexora-plan/price_sync.log
      exit 0
    fi
    S=$(date +%s)
    node tools/sync_prices_to_blockscout.mjs >> nexora-plan/price_sync.log 2>&1 || true
    E=$(date +%s)
    echo "$(date -Is) sync took $((E-S))s" >> nexora-plan/price_sync.log
  ) 9>"$LOCK"
  sleep 300
done
