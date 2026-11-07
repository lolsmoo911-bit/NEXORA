#!/usr/bin/env bash
# Keeps the OpenCode web stack alive. Safe to run repeatedly.
WS=/home/runner/workspace
OC="$WS/.config/npm/node_global/bin/opencode"
LOG=/tmp/opencode
mkdir -p "$LOG"

# 1. OpenCode server (the one the web UI talks to).
if ! pgrep -f "$OC serve" >/dev/null 2>&1; then
  nohup "$OC" serve --hostname 127.0.0.1 --port 4096 \
    > "$LOG/oc-serve.log" 2>&1 &
  sleep 4
fi

# 2. API gateway that proxies /api/* -> OpenCode on 4096.
#    The 4096 instance generates its OWN password (printed in oc-serve.log), which
#    is NOT the one in service.json -- that file belongs to the background service.
if ! pgrep -f "artifacts/api-server/dist/index.mjs" >/dev/null 2>&1; then
  PW=$(grep -o 'server password .*' "$LOG/oc-serve.log" 2>/dev/null | tail -1 | cut -d' ' -f3)
  OPENCODE_WEB_URL="http://127.0.0.1:4096" \
  OPENCODE_WEB_PASSWORD="$PW" \
  PORT=8080 \
  nohup node "$WS/artifacts/api-server/dist/index.mjs" \
    > "$LOG/api-server.log" 2>&1 &
  sleep 3
fi

# 3. Public tunnel. Reuse the URL if a tunnel is already alive.
if ! pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
  nohup "$WS/bin/cloudflared" tunnel --url http://127.0.0.1:8080 --no-autoupdate \
    > "$LOG/cf.log" 2>&1 &
  sleep 8
fi

URL=$(grep -o 'https://[-a-z0-9]*\.trycloudflare\.com' "$LOG/cf.log" 2>/dev/null | tail -1)
[ -n "$URL" ] && echo "$URL" > "$LOG/public-url.txt"

echo "opencode serve : $(pgrep -fc "$OC serve")"
echo "api gateway    : $(pgrep -fc 'artifacts/api-server/dist/index.mjs')"
echo "cloudflared    : $(pgrep -fc 'cloudflared tunnel')"
echo "public url     : $(cat "$LOG/public-url.txt" 2>/dev/null)"