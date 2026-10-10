# Bridge runbook — ChatGPT ⇄ OpenCode for NEXORA

**Status: bridge implemented and protocol-tested; the ChatGPT-side connection is NOT yet
made and is NOT claimed.** Nothing in this repository stores a secret.

Date: 2026-10-10. Last verified CI run: `38092608463` (bridge tests, all steps green).

---

## 1. What was built

A least-privilege MCP (Model Context Protocol) server in `bridge/` that lets a
reviewer (ChatGPT, via a custom app) inspect the NEXORA repository and drive the
OpenCode agent working on it, and read results back.

```
ChatGPT custom app (developer mode)
        │  MCP Streamable HTTP  (outbound-only tunnel; no public listener)
        ▼
   tunnel-client           ← authentication and headers are handled here
        │  stdio  (preferred)  or  HTTP loopback
        ▼
  bridge (this repo, least privilege, 9 tools)
        │  HTTP + optional Basic auth
        ▼
  opencode serve  (HTTP API, the agent)
        │
        ▼
  NEXORA workspace (read-only git verbs only)
```

Two hosting shapes are supported and both are exercised by tests:

- **stdio** (`bridge/src/index.mjs --stdio`): `tunnel-client` spawns the bridge. No
  listener, no port, no bearer token. This is the smaller attack surface.
- **HTTP** (`--http`): the bridge listens on `127.0.0.1` only and requires
  `BRIDGE_TOKEN`. Use this only if the tunnel is pointed at a URL.

ChatGPT's own documentation states the supported remote MCP transports are **SSE and
streaming HTTP**; stdio is never exposed to ChatGPT in either shape because the tunnel
terminates the protocol.

## 2. Components

| File | Role |
|---|---|
| `bridge/src/config.mjs` | All configuration. Loopback-only defaults, bounded limits, secret redaction. |
| `bridge/src/http.mjs` | The Streamable HTTP endpoint, written against the current MCP transport specification. |
| `bridge/src/opencode-client.mjs` | Bounded client for the OpenCode HTTP API (health, sessions, messages, submit, abort). |
| `bridge/src/repo.mjs` | Repository access via `execFile` with a **fixed verb allowlist**. Never a shell string. |
| `bridge/src/server.mjs` | MCP server: `initialize`, `tools/list`, `tools/call`, `ping`; the tool surface and its annotations. |
| `bridge/src/index.mjs` | Entry point: `--stdio`, `--http` (loopback), `--check`. |
| `bridge/test/bridge.test.mjs` | Unit tests: protocol, validation, auth, safety, ChatGPT app contract. |
| `bridge/test/mcp-http-conformance.test.mjs` | Each assertion maps to a clause of the MCP Streamable HTTP specification. |
| `bridge/test/opencode-contract.test.mjs` | Pins the exact request shapes sent to the documented OpenCode server API. |
| `bridge/test/smoke-stdio.mjs` | Real bidirectional round trip against a fake OpenCode API over a real socket. |
| `bridge/test/opencode-real-probe.mjs` | Read-only Level 4 probe against a **real** `opencode serve`. Not run in CI (see §5). |
| `.github/workflows/bridge-tests.yml` | Runs every level above on every `bridge/**` change. |

## 3. Tool surface (the entire capability set)

**Read-only** (all carry `readOnlyHint: true`):

| Tool | What it does |
|---|---|
| `bridge_health` | Is this bridge configured? Is the OpenCode API reachable, healthy, or password-protected? |
| `nexora_git_status` | Branch, changed/untracked files, HEAD sha. |
| `nexora_diff` | Bounded unified diff (`ref`, `staged`, `path`). |
| `nexora_log` | Bounded recent commits. |
| `nexora_docs_index` | Which phase reports exist. |
| `opencode_list_sessions` | Sessions on the OpenCode server. |
| `opencode_task_status` | Recent messages of a session (the agent's output). |

**Write** (`readOnlyHint: false`, so ChatGPT treats them as write actions and asks for
confirmation):

| Tool | Annotations | What it does |
|---|---|---|
| `opencode_submit_task` | `destructiveHint: false` | Adds one message to an existing session. Does not create a session, delete data, push, or deploy. |
| `opencode_cancel_task` | `destructiveHint: true` | Aborts a running session. |

**There is deliberately no `exec`, `shell`, `run_command`, or equivalent tool.** The
repository module invokes `git` as an executable with a validated argument list and a
verb allowlist (`status`, `diff`, `log`, `rev-parse`, `branch`, `show`, `ls-files`), so a
caller cannot inject a shell command even through a `ref` argument — that is validated
and tested.

## 4. Security properties (each one is tested)

1. **No secret in the repo.** All credentials come from the environment or a file
   outside the workspace. CI greps `bridge/` and this runbook for credential-shaped
   strings and fails if any are committed.
2. **Loopback only.** The bridge binds `127.0.0.1` by default and prints a warning if
   `BRIDGE_ALLOW_NON_LOOPBACK_BIND` is set. Remote access requires a tunnel in front.
3. **The OpenCode URL must be loopback** unless `BRIDGE_ALLOW_REMOTE_OPENCODE` is set
   after explicit review, and it may never carry userinfo.
4. **Authentication for HTTP.** `BRIDGE_TOKEN` is required or the bridge refuses to
   start in `--http`. Comparison is timing-safe, and auth is checked before anything
   else is parsed.
5. **Bounded everything.** HTTP body size, response size, diff size, message count,
   task length and request timeout all have hard, upper-bounded limits. Over-limit
   input is rejected, never silently truncated.
6. **Redaction.** Passwords, tokens, GitHub/OpenAI key shapes, hex private keys and URL
   userinfo are redacted from every log line and every tool response. `bridge_health`
   reports the endpoint as `scheme://host:port`, never the raw URL.
7. **Write actions are separable.** `BRIDGE_ALLOW_SUBMIT=false` or
   `BRIDGE_ALLOW_CANCEL=false` removes the write tools (useful for a read-only
   reviewer connection).
8. **No arbitrary code path.** No tool evaluates caller-supplied code.

## 5. Evidence levels — what is actually proven

CI runs four levels. The distinction between them is the point of this section:
**a green run does not mean ChatGPT is connected.**

| Level | What it exercises | Status in CI |
|---|---|---|
| 1 | Unit tests: protocol, validation, auth, safety, redaction, ChatGPT app contract | **Executed, passing** |
| 2 | MCP Streamable HTTP conformance, over a real socket | **Executed, passing** |
| 3 | End-to-end bidirectional round trip: submit → agent receives → reply read back, against a **fake** OpenCode API | **Executed, passing** |
| 4 | The **same** read-only probes against a **real** `opencode serve` | **NOT RUN** — no real OpenCode server is reachable from CI. The workflow prints `NOT RUN (documented limit)` and exits 0 so the gap is visible in the log rather than hidden behind a skip. |

Observed in run `38092608463`:

- Level 1–3: `# tests 64 / # pass 64 / # fail 0`.
- Level 3: 14/14 smoke checks, including `a JSON-RPC notification is accepted with 202
  and no body`, `the agent actually received the task text` (the exact payload
  `{"noReply":true,"parts":[{"type":"text","text":"Inspect the NEXORA repo…"}]}` was
  observed at the fake agent), and `reviewer can read the agent reply back`.
- Level 4: `NOT RUN (documented limit): no real OpenCode server is configured for CI.`
- Credential scan: `OK: no credential-shaped strings in the bridge`.

### What Level 3 does **not** prove

Level 3 uses a fake OpenCode API implemented from the documented contract. It proves
the bridge's transport, auth, limits, tool dispatch and round-trip logic. It does
**not** prove that a real, currently-installed `opencode` binary accepts the exact
`/session/:id/message` payload or returns the documented message shape. Level 4 exists
to close exactly that gap and has not been run.

### What no level proves

A call that originates from an actual ChatGPT custom app. That requires the owner-side
setup in §7. Until such a call is made and its response read back, the only correct
claim is: **"the bridge and its transport are implemented, specification-tested, and
verified against a conforming agent API contract."** Not "ChatGPT is connected".

## 6. MCP Streamable HTTP conformance

Implemented and tested against
<https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http>.
Each item below has a test in `bridge/test/mcp-http-conformance.test.mjs`:

| Requirement | Behaviour |
|---|---|
| Single MCP endpoint | `/mcp` by default (`BRIDGE_MCP_PATH`); any other path is 404. |
| POST only | `GET` and `DELETE` are 405 with an `Allow: POST` header (this revision defines no GET stream and no protocol-level sessions). |
| Origin validation | An absent `Origin` is accepted (a tunnel sends none). A present `Origin` with no allowlist is 403, which is the DNS-rebinding defence. `BRIDGE_ALLOWED_ORIGINS` opts specific origins in. |
| Protocol version | `MCP-Protocol-Version` is required; a missing header is 400 `-32020` HeaderMismatch; an unsupported version is 400 with the list of supported versions; a header/body `_meta` mismatch is 400 `-32020`. |
| Notifications | A JSON-RPC notification is answered **202 Accepted with no body** (an earlier version of this bridge wrongly returned 200 with a body; that is fixed and tested). |
| Requests | A JSON-RPC request is answered 200 `application/json`. |
| Unknown method | 404 with JSON-RPC `-32601`, which is how a modern server is distinguished from a legacy HTTP+SSE server that merely 404s the endpoint. |
| One message per POST | A batched array, or a client posting a JSON-RPC *response*, is 400. |
| Body limit | Over `BRIDGE_MAX_HTTP_BODY` is 413 and the body is never parsed. |
| Content type | Non-JSON is 415; unparsable JSON is 400 `-32700`. |

## 7. How the bridge finds the agent

The bridge talks to the OpenCode HTTP API documented at
<https://docs.opencode.ai/docs/server/>.

```bash
# 1. start the agent's API server (on the machine that hosts OpenCode), loopback only
opencode serve --port 4096            # optionally with OPENCODE_SERVER_PASSWORD set

# 2. point the bridge at it
export OPENCODE_BASE_URL=http://127.0.0.1:4096
export OPENCODE_SERVER_PASSWORD=...   # only if the server was started with one
export NEXORA_WORKSPACE=/path/to/NEXORA

# 3. validate without exposing anything
node bridge/src/index.mjs --check
```

`--check` prints the configuration and reachability with no secrets and exits non-zero
if the configuration is invalid.

## 8. One-time owner setup to connect ChatGPT

This is the single step that cannot be performed from inside the agent sandbox. It needs
a ChatGPT account, a Platform organisation with tunnel permissions, and a host that stays
up. Sources for every step below are linked inline.

### 8.1 Plan and permission prerequisites (check these first)

| Requirement | Consequence if unmet |
|---|---|
| Full MCP **with write actions** is beta for **Business, Enterprise and Edu**. Pro can connect custom MCP servers with **read/fetch permissions only**. | On Pro, `opencode_submit_task` and `opencode_cancel_task` are never exposed to the model. A read-only reviewer connection still works. |
| Developer mode / "Create custom MCP connectors" must be enabled by a workspace admin on Business; Enterprise/Edu can grant it per member via RBAC. | "Add custom MCP server" is not available at all. |
| Creating and running a tunnel needs Platform RBAC **Tunnels Read + Manage** (to create) and **Read + Use** (to run `tunnel-client`). | The tunnel cannot be created or selected. |
| Adding and using custom MCP servers in ChatGPT is a separate workspace permission and is subject to Lockdown. | The app cannot be installed or used in a conversation. |

Sources: OpenAI Help Center, *Developer mode and MCP apps in ChatGPT*; OpenAI developer
guide, *Add custom MCP server*; OpenAI developer guide, *Secure MCP Tunnel*.

These are account-side prerequisites that this repository cannot assert. Verify them in
the account before spending time on the rest of the setup.

### 8.2 Host and run

1. **Host the agent.** OpenCode must run on a machine that stays up, serving its API on
   loopback. The current agent sandbox cannot do this — it has no persistent process and
   no reachable listener; see `docs/agent-coordination.md`.
2. **Install `tunnel-client`** on that same host (Platform tunnel settings, or the
   latest release from `openai/tunnel-client`). Point the runbook at the latest-release
   URL rather than pinning a version.
3. **Create a tunnel** in Platform tunnel settings and associate it with both the owning
   Platform organisation and the target ChatGPT workspace. A tunnel associated only with
   a Platform organisation does not appear in an Enterprise/Edu workspace.
4. **Point `tunnel-client` at the bridge.** Preferred — stdio, no listener:

   ```bash
   export CONTROL_PLANE_API_KEY="..."     # never paste this into a chat
   tunnel-client init \
     --sample sample_mcp_stdio_local \
     --profile nexora \
     --tunnel-id tunnel_... \
     --mcp-command "node /path/to/NEXORA/bridge/src/index.mjs --stdio"
   tunnel-client doctor --profile nexora --explain
   tunnel-client run   --profile nexora
   ```

   The bridge needs `OPENCODE_BASE_URL` and `NEXORA_WORKSPACE` in the environment it is
   spawned into. Alternatively use `--mcp-server-url http://127.0.0.1:8787/mcp` with the
   bridge running `--http` and `BRIDGE_TOKEN` set.

5. **Confirm the tunnel is healthy** at `tunnel-client`'s loopback-only `/ui`, or via
   `/healthz`, `/readyz`, `/metrics`. Keep `tunnel-client run` alive while testing;
   connector discovery and tool calls depend on it.

### 8.3 Connect from ChatGPT

At <https://chatgpt.com/plugins>: plus button → **Add custom MCP server** → under
**Connection** choose **Tunnel** → select the tunnel (or paste the `tunnel_id`) →
configure authentication → accept the risk warning → **Create as a plugin**. Then install
the plugin and mention it with `@` in a conversation.

### 8.4 The two-way smoke test from ChatGPT

Run these in order and read the actual replies:

1. `bridge_health` — expect `apiReachable: true` and `api.healthy: true`.
2. `nexora_git_status` — expect a real branch and a 40-character HEAD sha.
3. `opencode_submit_task` with a harmless task such as
   *"Report the current branch name. Do not modify anything."*
4. `opencode_task_status` — expect the agent's actual reply.

Step 3 is the one that will fail on a Pro plan, and that failure is a plan limitation,
not a bridge defect. Record which of the four steps produced a real reply; that record is
the evidence that the connection exists.

Do not paste any token or password into a chat. Provide it through the environment or the
client configuration.

## 9. Operational notes that will save time

- **Read-only detection is annotation-driven.** ChatGPT respects `readOnlyHint` and
  treats any tool without it as a write action requiring confirmation. All seven read
  tools set it explicitly; a test enforces this.
- **Descriptions are part of the deliverable.** On Business workspaces a published app's
  tool list **cannot be edited in place** — changing a description means recreating and
  republishing. Tools whose descriptions do not clearly say what they do and do not do
  are more likely to be rejected by ChatGPT's safety checks before the request even
  reaches this server. Write the descriptions carefully *before* publishing.
- **`instructions` matters.** The first 512 characters are what some clients surface on
  their own, so they are written to stand alone; a test enforces that.
- **Errors are structured, not prose.** Upstream failures carry `err.code`
  (`upstream_status`, `upstream_unreachable`, `upstream_timeout`, `no_session`,
  `forbidden`, `invalid_input`) so callers can branch without string matching.

## 10. Costs and prerequisites

- The bridge itself is free software on infrastructure the owner already has.
- The OpenAI Secure MCP Tunnel path requires a **Platform runtime API key**
  (`CONTROL_PLANE_API_KEY`). Whether that is usable at zero cost depends on the account's
  Platform billing state, which this project cannot inspect and has not assumed.
- ChatGPT-side developer mode and write-action support depend on the plan, as in §8.1.

No paid resource has been created by this project.

## 11. Rollback

The bridge is additive. To roll it back, delete `bridge/` and
`.github/workflows/bridge-tests.yml`, or revert the commits that added them. It touches
no chain configuration, no consensus code, and no existing NEXORA runtime.

## 12. Known limitations (honest)

- Level 4 (real OpenCode binary) has never been executed; Level 3 uses a fake server
  built from the documented contract.
- No call has ever originated from ChatGPT. The connection is documented, not proven.
- The bridge can drive an OpenCode agent; it does not itself *think*. Review loops still
  require an OpenCode session to be running.
- Repository access is limited to the current workspace and to read-only git verbs, so
  the reviewer cannot (and should not) push directly.
- MCP sampling, resources and prompts are not implemented; only tools are exposed, which
  is the minimum a reviewer app needs.
- `opencode_submit_task` uses the documented `noReply` flag and therefore does **not**
  block until the agent finishes; the reviewer polls `opencode_task_status` instead.