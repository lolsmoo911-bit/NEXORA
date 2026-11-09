# Cloudflare Phase 8A — Persistent Tunnel Preparation (Audit Only)

**Created:** 2026-11-09
**Workspace:** `/home/runner/workspace`

---

## 1. Current runtime audit

### 1.1 cloudflared

| Item | Value |
|---|---|
| Version | `cloudflared version 2026.10.0` (built 2026-10-05) |
| Binary path | `/home/runner/workspace/bin/cloudflared` |
| Named tunnel config | **None** — no `config.yml`, no `cert.pem`, no `.cloudflared/` directory |
| Tunnel type | **Quick Tunnel** (ephemeral) — `cloudflared tunnel --url http://127.0.0.1:8085 --no-autoupdate` |
| Current URL | `https://anonymous-vessels-profiles-skins.trycloudflare.com` (changes on restart) |
| Previous URL | `https://flows-counter-charitable-clinical.trycloudflare.com` |
| Cloudflare account login | **Not performed** — no credentials stored |

### 1.2 Watchdog

| Item | Value |
|---|---|
| Script | `scripts/opencode-web-watchdog.sh` |
| Status | Running (PID varies) |
| Components managed | 1. `opencode serve` on 127.0.0.1:4096, 2. api-server gateway on :8085, 3. cloudflared quick tunnel to 8085 |
| Restart interval | 10 seconds |
| Health check | `port_up` via `/proc/net/tcp` |
| Log | `.local/state/opencode-web/watchdog.log` |

### 1.3 Local endpoints

| Port | Service | Status |
|---|---|---|
| 4096 | OpenCode Web (opencode serve) | HTTP 200 |
| 49374 | OpenCode background service | Running |
| 8085 | API-server gateway (auth injection) | HTTP 200 |
| 8080 | Replit managed api-server | Not running (Replit's own, not OpenCode's) |

### 1.4 Gateway authentication

The gateway (`artifacts/api-server/src/opencodeProxy.ts`) injects Basic auth:
- Reads password from `OPENCODE_WEB_PASSWORD` env var or `oc-serve.log`
- Injects `authorization: Basic base64(opencode:<password>)` header
- Upstream OpenCode server requires this password
- **Gateway auth is enabled and functional**

### 1.5 Cloudflare Access

- **No Access application or policy configured.**
- Quick Tunnel URL is publicly accessible without authentication (only gateway's injected auth protects it, but the URL itself is unauthenticated).
- **Security risk:** Anyone with the trycloudflare.com URL can access the OpenCode Web UI.

### 1.6 Duplicate processes

- Only one cloudflared process runs at a time (watchdog uses `pgrep` check).
- Only one watchdog instance runs (Replit workflow "always on").
- No duplicate tunnels detected.

---

## 2. Existing Cloudflare configuration

### 2.1 Domain names found

| Domain | Source | Status |
|---|---|---|
| `sageswap.dpdns.org` | `docs/SECURITY-THREAT-MODEL.md` (T-16) | Mentioned as task-specific named subdomain under Cloudflare One |
| `nexora.io` | Multiple docs | **NOT owned by project** — registered at GoDaddy under WHOIS privacy since 2024-08-05 |

**No owned domain confirmed for this project.** The only Cloudflare-related domain reference is `sageswap.dpdns.org`.

### 2.2 Tunnel identifiers

- **No named tunnel exists.** No tunnel ID, no credentials, no `config.yml`.
- Only Quick Tunnels have been used (ephemeral trycloudflare.com URLs).

### 2.3 Environment variables

- **No `CLOUDFLARE_TUNNEL_TOKEN`** or any Cloudflare-related env var is set.
- Replit secrets contain only `SESSION_SECRET`.
- No `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, or similar.

### 2.4 Cloudflare account

- No Cloudflare login has been performed on this Repl.
- No `cert.pem` or tunnel credentials exist.

---

## 3. Persistent tunnel design

### 3.1 Architecture

```
Internet -> Cloudflare Edge -> Named Tunnel "nexora-opencode" -> http://127.0.0.1:8085 (gateway) -> http://127.0.0.1:4096 (opencode serve)
```

### 3.2 Tunnel configuration (to be created)

```yaml
# ~/.cloudflared/config.yml (or remotely managed)
tunnel: <TUNNEL_ID>
credentials-file: /home/runner/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: <hostname>.sageswap.dpdns.org
    service: http://127.0.0.1:8085
  - service: http_status:404
```

### 3.3 DNS hostname requirements

- A CNAME record must be created in Cloudflare DNS pointing the chosen hostname to `<TUNNEL_ID>.cfargotunnel.com`.
- The hostname must be under a domain that the user controls in Cloudflare.
- Currently identified domain: `sageswap.dpdns.org` (from threat model docs).
- **The user must confirm which domain/hostname to use.**

### 3.4 Cloudflare Access protection

- Create a Cloudflare Access application for the chosen hostname.
- Add an Allow policy for the authorized user account (email-based).
- Access will intercept requests before they reach the tunnel.
- The gateway's injected Basic auth provides a second layer of protection.
- **Do not use "Everyone" or allow-all policies.**

### 3.5 Secure Replit Secret integration

- Environment variable name: `CLOUDFLARE_TUNNEL_TOKEN`
- Store the tunnel token as a Replit Secret (not in code, `.env`, or Git).
- Watchdog reads it: `export CLOUDFLARE_TUNNEL_TOKEN=$(replit secrets get CLOUDFLARE_TUNNEL_TOKEN)` or via Replit's env injection.
- The token is used with: `cloudflared tunnel run --token $CLOUDFLARE_TUNNEL_TOKEN`
- **Never hardcode the token in scripts or config files.**

### 3.6 Watchdog integration (prevent duplicates)

The existing watchdog must be updated to:
1. Check for existing named tunnel process before starting: `pgrep -f "cloudflared tunnel run"`
2. Use the token: `cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN"` instead of `--url`
3. Verify tunnel health via Cloudflare API or local metrics
4. Log only status, never tokens or credentials

### 3.7 Health checks and reconnection

- `cloudflared` has built-in reconnection (exponential backoff).
- Watchdog checks tunnel health every 10 seconds via `pgrep`.
- If tunnel dies, watchdog restarts it within 10 seconds.
- Gateway health: `curl -s http://127.0.0.1:8085/` (HTTP 200 expected).
- OpenCode health: `curl -s http://127.0.0.1:4096/` (HTTP 200 expected).

### 3.8 Safe logging

- Log only: tunnel status, URL, process PIDs, HTTP status codes.
- **Never log:** tokens, credentials, passwords, or full URLs with embedded auth.
- The existing watchdog already follows this pattern (logs `serve=1 gateway=1 tunnel=1 url=...`).

---

## 4. Security requirements

| Requirement | Status |
|---|---|
| OpenCode NOT publicly accessible without auth | Warning: Currently exposed via Quick Tunnel (no Access policy) |
| Cloudflare Access with explicit Allow policy | Not configured |
| Gateway authentication enabled | Yes (Basic auth injection) |
| Ports 4096/49374/8085 not directly exposed | Yes (only via tunnel) |
| No secrets in Git or logs | Yes (verified) |
| No hardcoded credentials | Yes (watchdog uses env vars) |

**Critical:** The current Quick Tunnel URL is publicly accessible. Cloudflare Access must be configured before using the persistent tunnel in production.

---

## 5. Replit 24/7 uptime assessment

| Item | Value |
|---|---|
| Replit org type | `PERSONAL` (free) |
| Enterprise | `false` |
| Deployment target | `autoscale` (paid feature) |
| Free Repl behavior | Sleeps when idle |
| Reserved VM | Not configured (paid feature) |

### Limitations

1. **Free Repls sleep when idle** — the OpenCode Web UI will become unavailable after inactivity.
2. **Autoscale deployment is a paid feature** — cannot be used on free personal accounts.
3. **No Reserved VM** — without a paid Reserved VM, the Repl will not run 24/7.
4. **Watchdog survives shell exit** — it runs as a Replit workflow (`isBackground = true`, `restart = true`), so it persists as long as the Repl is awake.

### Cost-related decision required

For true 24/7 operation, the user must:
- Upgrade to Replit Core/Teams (paid) for Reserved VM or Autoscale deployment, OR
- Use an external always-on host (VPS, cloud instance) with the OpenCode gateway.

**This is a billing decision that cannot be made by the agent.**

---

## 6. Dashboard actions required (user must perform)

1. **Log in to Cloudflare:** `cloudflared tunnel login` (opens browser for OAuth)
2. **Create named tunnel:** `cloudflared tunnel create nexora-opencode`
3. **Note the tunnel ID** returned by the create command
4. **Create DNS record:** In Cloudflare dashboard -> DNS -> Add CNAME record:
   - Name: chosen hostname (e.g., `opencode.sageswap.dpdns.org`)
   - Target: `<TUNNEL_ID>.cfargotunnel.com`
   - Proxy: enabled (orange cloud)
5. **Create Access application:** In Cloudflare Zero Trust -> Access -> Applications -> Add application
   - Application type: Self-hosted
   - Application domain: chosen hostname
   - Policy: Allow -> specific email(s)
6. **Store tunnel token:** Copy the tunnel token and add it as a Replit Secret named `CLOUDFLARE_TUNNEL_TOKEN`
7. **Update watchdog:** Modify `start_tunnel()` to use `cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN"` instead of `--url`

---

## 7. Exact next commands for OpenCode (when authorized)

```bash
# 1. Login to Cloudflare (opens browser)
cloudflared tunnel login

# 2. Create named tunnel
cloudflared tunnel create nexora-opencode
# Note the tunnel ID from output

# 3. Create config.yml
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: <TUNNEL_ID>
credentials-file: /home/runner/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: <hostname>.sageswap.dpdns.org
    service: http://127.0.0.1:8085
  - service: http_status:404
EOF

# 4. Store token as Replit Secret
# (via Replit UI: Secrets -> Add -> CLOUDFLARE_TUNNEL_TOKEN = <token>)

# 5. Update watchdog start_tunnel() function:
# Replace: nohup "$WS/bin/cloudflared" tunnel --url http://127.0.0.1:8085 --no-autoupdate
# With:    nohup "$WS/bin/cloudflared" tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" --no-autoupdate

# 6. Test (without stopping current tunnel):
# cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" &
# curl -s https://<hostname>.sageswap.dpdns.org/
```

---

## 8. Summary

| Item | Status |
|---|---|
| Current tunnel type | Quick Tunnel (ephemeral, trycloudflare.com) |
| Named tunnel | Not created |
| Custom domain | Not configured (only `sageswap.dpdns.org` mentioned in docs) |
| Cloudflare Access | Not configured |
| `CLOUDFLARE_TUNNEL_TOKEN` | Not set |
| Cloudflare account login | Not performed |
| Replit 24/7 hosting | Free personal (sleeps when idle) |
| Gateway auth | Enabled (Basic auth injection) |
| Watchdog | Running (self-healing, 10s interval) |

**No tunnel created, no DNS changed, no services modified, no credentials stored. Audit and preparation only.**

**Awaiting user authorization to proceed with tunnel creation.**