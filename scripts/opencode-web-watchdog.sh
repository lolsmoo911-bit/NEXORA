#!/usr/bin/env bash
# Self-healing loop for the OpenCode web stack.
#   1. opencode serve on 127.0.0.1:4096   (the UI's real backend)
#   2. api-server gateway on :8080        (proxies + injects loopback auth)
#   3. cloudflared quick tunnel on :8080  (public URL)
# Any component that dies is restarted within ~10s, so closing the browser (or a
# crash) never leaves you without a link.
WS=/home/runner/workspace
OC="$WS/.config/npm/node_global/bin/opencode"
LOG="$WS/.local/state/opencode-web"
mkdir -p "$LOG"

start_opencode() {
  pgrep -f "$OC serve" >/dev/null 2>&1 && return
  nohup "$OC" serve --hostname 127.0.0.1 --port 4096 \
    > "$LOG/oc-serve.log" 2>&1 &
  sleep 5
}

port_up() { # $1 = decimal port; true when something is LISTENing on it
  local hex
  hex=$(printf '%04X' "$1")
  grep -qi ":${hex} 00000000:0000 0A" /proc/net/tcp
}

start_gateway() {
  port_up 8085 && return
  # Port 8080 is owned by Replit's own managed api-server, so the gateway that
  # actually carries the auth token runs on 8085 and the tunnel points there.
  # The 4096 instance prints its OWN password; service.json belongs to the
  # background service and is a different credential.
  local pw
  pw=$(grep -o 'server password .*' "$LOG/oc-serve.log" 2>/dev/null | tail -1 | cut -d' ' -f3)
  OPENCODE_WEB_URL="http://127.0.0.1:4096" \
  OPENCODE_WEB_PASSWORD="$pw" \
  PORT=8085 \
  nohup node "$WS/artifacts/api-server/dist/index.mjs" \
    > "$LOG/gateway.log" 2>&1 &
  sleep 3
}

start_tunnel() {
  pgrep -f "cloudflared tunnel" >/dev/null 2>&1 && return
  nohup "$WS/bin/cloudflared" tunnel --url http://127.0.0.1:8085 --no-autoupdate \
    > "$LOG/tunnel.log" 2>&1 &
  sleep 10
}

while true; do
  start_opencode
  start_gateway
  start_tunnel
  grep -o 'https://[-a-z0-9]*\.trycloudflare\.com' "$LOG/tunnel.log" 2>/dev/null \
    | tail -1 > "$LOG/public-url.txt"
  printf '%s serve=%s gateway=%s tunnel=%s url=%s\n' \
    "$(date -u +%H:%M:%S)" \
    "$(pgrep -fc "$OC serve")" \
    "$(port_up 8085 && echo 1 || echo 0)" \
    "$(pgrep -fc 'cloudflared tunnel')" \
    "$(cat "$LOG/public-url.txt" 2>/dev/null)" >> "$LOG/watchdog.log"
  sleep 10
done