# Bridge runbook — ChatGPT ⇄ OpenCode for NEXORA

**Status: implemented and tested; the final ChatGPT-side connector step needs one
one-time action from the owner.** Nothing in this repository stores a secret.

Date: 2026-10-10.

---

## 1. What was built

A least-privilege MCP (Model Context Protocol) server in `bridge/` that lets a
reviewer (ChatGPT, via a custom connector) inspect the NEXORA repository and drive the
OpenCode agent working on it, and read results back.

```
ChatGPT custom connector
        │  MCP over HTTPS (tunnelled, authenticated)
        ▼
  bridge (this repo, loopback only, bearer token)
        │  HTTP + optional Basic auth
        ▼
  opencode serve  (HTTP API, the agent)
        │
        ▼
  NEXORA workspace (read-only git verbs only)
```

## 2. Components

| File | Role |
|---|---|
| `bridge/src/config.mjs` | All configuration. Loopback-only defaults, limits, secret redaction. |
| `bridge/src/opencode-client.mjs` | Bounded client for the OpenCode HTTP API (health, sessions, messages, submit, cancel). |
| `bridge/src/repo.mjs` | Repository access via `execFile` with a **fixed verb allowlist**. Never a shell string. |
| `bridge/src/server.mjs` | MCP server: `initialize`, `tools/list`, `tools/call`, `ping`. |
| `bridge/src/index.mjs` | Entry point: `--stdio`, `--http` (loopback), `--check`. |
| `bridge/test/bridge.test.mjs` | 21 unit tests: protocol, validation, auth, safety. |
| `bridge/test/smoke-stdio.mjs` | Real bidirectional round trip against a fake OpenCode API. |
| `.github/workflows/bridge-tests.yml` | Runs all of the above on every `bridge/**` change. |

## 3. Tool surface (the entire capability set)

**Read-only:**

| Tool | What it does |
|---|---|
| `bridge_health` | Is this bridge configured? Is the OpenCode API reachable and authenticated? |
| `nexora_git_status` | Branch, changed/untracked files, HEAD sha. |
| `nexora_diff` | Bounded unified diff (`ref`, `staged`, `path`). |
| `nexora_log` | Bounded recent commits. |
| `nexora_docs_index` | Which phase reports exist. |
| `opencode_list_sessions` | Sessions on the OpenCode server. |
| `opencode_task_status` | Recent messages of a session (the agent's output). |

**Write / execute (clearly marked):**

| Tool | What it does |
|---|---|
| `opencode_submit_task` | Hands a bounded task to the agent. The only tool that changes agent state. |
| `opencode_cancel_task` | Aborts a running session. Destructive. |

**There is deliberately no `exec`, `shell`, `run_command`, or equivalent tool.** The
repository module invokes `git` as an executable with a validated argument list and a
verb allowlist (`status`, `diff`, `log`, `rev-parse`, `branch`, `show`, `ls-files`), so a
caller cannot inject a shell command even through a `ref` argument — that is validated
and tested.

## 4. Security properties (each one is tested)

1. **No secret in the repo.** All credentials come from the environment or a file
   outside the workspace. CI greps `bridge/` for credential-shaped strings and fails if
   any are committed.
2. **Loopback only.** The bridge binds `127.0.0.1`. It never re-exposes the OpenCode
   API to the internet. Remote access requires a private tunnel in front of it.
3. **Authentication required for HTTP.** `BRIDGE_TOKEN` must be set or the bridge
   refuses to start in `--http` mode. The bearer comparison is timing-safe.
4. **Bounded everything.** Response size, diff size, message count, task length, and
   request timeout all have hard limits; over-limit input is rejected, not truncated
   silently.
5. **Redaction.** Passwords, tokens, GitHub/OpenAI key shapes, and hex private keys are
   redacted from every log line and every tool response.
6. **Write actions are separable.** `BRIDGE_ALLOW_SUBMIT=false` or
   `BRIDGE_ALLOW_CANCEL=false` removes the write tools entirely (useful for a
   read-only reviewer connection).
7. **No arbitrary code path.** There is no tool that evaluates caller-supplied code.

## 5. What was actually tested (evidence)

CI run: **the `Bridge — OpenCode MCP bridge tests` workflow, green.** It executes:

- **21/21 unit tests** — protocol (`initialize`, `tools/list`, `tools/call`, `ping`,
  unknown-method handling), validation (config, task size, git ref, path filter),
  auth (token required for http), safety (no shell tool; write tools separable;
  unreachable upstream returns a clear error, never a hang), redaction.
- **14/14 smoke checks** — a real bidirectional round trip against a fake OpenCode API:
  - bridge starts on loopback;
  - a **wrong** bearer token is rejected with **401**;
  - a **correct** token gets health and sees the agent API;
  - a task submitted "from the reviewer side" **lands on the agent** (the fake agent
    echoes the exact task text back in the transcript);
  - the agent's reply is then **read back** through the bridge;
  - the repository tools return real data from this repository (real branch, real
    commit sha, real diff);
  - a shell-ish git ref is refused; an unknown tool is refused structurally.

(The exact transcript is in the workflow log; the transcript is the evidence, not this
summary.)

**What is NOT yet proven:** a call that originates from an actual ChatGPT custom MCP
connector. That requires the one-time owner setup in §7 and cannot be done from inside
this environment. Until that call happens, the correct claim is "the bridge and its
transport are implemented and tested against a conforming agent API", not "ChatGPT is
connected".

## 6. How the bridge finds the agent

The bridge talks to the OpenCode HTTP API documented at
https://docs.opencode.ai/docs/server/. To use it against a real agent:

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

## 7. One-time owner setup to connect ChatGPT

This is the single step I cannot perform from here, because it requires a ChatGPT
account/plan and, for write actions, workspace permissions.

1. **Host the agent.** OpenCode must run on a host that stays up, serving its API on
   loopback. The current agent sandbox cannot do this (no persistent process, no
   listener) — see `docs/agent-coordination.md`.
2. **Run the bridge** on that host in `--http` mode with a `BRIDGE_TOKEN` you choose.
3. **Expose it privately** via a private tunnel (for example an OpenAI Secure MCP Tunnel,
   or an equivalent authenticated tunnel). The bridge itself never listens on a public
   interface.
4. **Add the custom connector in ChatGPT** pointing at the tunnel URL, with the bearer
   token as configured by your client. Refer to the current official ChatGPT custom-app /
   MCP documentation for the exact UI steps and the plan/access tier that permits
   read and write tool calls — those prerequisites are on the ChatGPT side and are not
   something this repo can assert.
5. **Run the two-way smoke test** from ChatGPT: call `bridge_health`, then
   `opencode_submit_task` with a harmless test task, then `opencode_task_status` to
   read the reply.

Do not paste any token or password into a chat. Provide it through the environment or
your client configuration.

## 8. Costs and prerequisites

- The bridge itself is free software and runs on infrastructure you already have.
- ChatGPT-side connector access and any tunnel depend on your ChatGPT plan/workspace and
  the tunnel provider. I have not assumed any of those prerequisites are met, and this
  project has created no paid resources.

## 9. Rollback

The bridge is additive. To roll it back, delete `bridge/` and
`.github/workflows/bridge-tests.yml`, or revert the commits that added them. It touches
no chain configuration, no consensus code, and no existing NEXORA runtime.

## 10. Known limitations (honest)

- The bridge can drive an OpenCode agent; it does not itself *think*. Review loops still
  require an OpenCode session to be running.
- Repository access is limited to the current workspace and to read-only git verbs, so
  the reviewer cannot (and should not) push directly.
- The bridge does not implement MCP sampling or resources; only tools are exposed,
  which is the minimum a reviewer connector needs.
