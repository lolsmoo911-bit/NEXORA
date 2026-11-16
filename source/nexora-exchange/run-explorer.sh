#!/bin/bash
# Start BlockScout explorer (Custorium Scan) on :4000 with the captured env.
cd /home/runner/workspace/blockscout
export PATH="/nix/store/4k8132hr2kccip3xwsgw68nwk5nybrf8-elixir-1.18.4/bin:/nix/store/y13ik2ksx1g0rwkq14gnlvwci1v7rx0a-erlang-27.3.4.6/bin:$PATH"
export MIX_HOME=/home/runner/workspace/.mix
export MIX_ENV=dev
export DATABASE_URL="postgresql://blockscout:blockscout@localhost:5433/blockscout"
export ETHEREUM_JSONRPC_HTTP_URL="http://127.0.0.1:8545"
export ETHEREUM_JSONRPC_TRACE_URL="http://127.0.0.1:8545"
export ETHEREUM_JSONRPC_WS_URL="ws://127.0.0.1:8546"
export ETHEREUM_JSONRPC_VARIANT="geth"
export CHAIN_ID=902024
export COIN="CSTO"
export COIN_NAME="Custorium"
export NETWORK="Custorium"
export SUBNETWORK="Custorium Scan"
export BLOCKSCOUT_HOST="custorium-scan.sageswap.dpdns.org"
export PORT=4000
export DISABLE_EXCHANGE_RATES=false
export EXCHANGE_RATES_SOURCE=coin_gecko
export EXCHANGE_RATES_COINGECKO_COIN_ID=custorium
export EXCHANGE_RATES_COINGECKO_BASE_URL="http://127.0.0.1:4100/api/v3"
export EXCHANGE_RATES_PRICE_SOURCE=coin_gecko
export EXCHANGE_RATES_MARKET_CAP_SOURCE=coin_gecko
export DISABLE_MARKET=false
export DISABLE_TOKEN_EXCHANGE_RATE=true
export FOOTER_CHAT_LINK=""
export FOOTER_FORUM_LINK=""
echo "$(date -Is) starting BlockScout on :4000"
exec /nix/store/4k8132hr2kccip3xwsgw68nwk5nybrf8-elixir-1.18.4/bin/mix phx.server
