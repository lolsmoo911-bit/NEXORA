#!/usr/bin/env bash
# Build the epoch commit message from the ledger.
#
# This exists as a file rather than inline in the workflow because an earlier version nested
# double-quoted shell inside a YAML scalar, which is a class of mistake that is hard to see
# and easy to repeat. Here it is ordinary shell in an ordinary file.
set -euo pipefail

LEDGER="${1:-testnet/ledger.json}"

python3 - "$LEDGER" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if not d.get("appHash"):
    print("testnet: epoch produced no state")
else:
    print("testnet: epoch %s - height %s, cumulative %s blocks, app_hash %s" % (
        d["epoch"], d["height"], d["cumulativeBlocks"], d["appHash"][:16]))
PY
