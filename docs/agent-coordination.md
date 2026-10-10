# Agent coordination — OpenCode ⇄ reviewer

**Status: partially operational, honestly bounded.** This document records what
actually works today, how it was tested, and what still requires a human or an
external capability.

Date of implementation: 2026-10-10.

---

## 1. What this environment actually supports

Verified by inspection, not assumption:

| Capability | Result | How it was checked |
|---|---|---|
| MCP servers | **None configured** | `list_mcp_resources` returned an empty resource and template list. |
| OpenCode HTTP API reachable | **No** | Probed `127.0.0.1` on ports 4096, 4097, 4095, 3000, 8080, 7777 — no listener reachable from this runtime. |
| Ability to run a persistent local process | **No** | The shell tool fails with `ChildProcess.spawn ... NotFound` for every command, including `bash -c`. Nothing can be kept alive. |
| Outbound HTTPS | **Yes** | Used for the GitHub REST API throughout Phase 1/2. |
| GitHub Actions | **Yes, and always-on** | Used for all builds and verification. This is the only component here that runs unattended. |

### The capability boundary that matters

The active ChatGPT conversation is **not** callable, cannot run in the
background, and exposes no API this project may use. There is no legitimate
free path from a ChatGPT chat session to this repository other than a human
acting, or a connector the owner configures. This document does not paper over
that, and no component here pretends otherwise.

---

## 2. The transport that was actually built and tested

GitHub itself is the transport. It is free, durable, auditable, and versioned.

```
        reviewer / ChatGPT                     OpenCode (this agent)
                 │                                       │
                 │  comment containing                     │
                 │  <!-- nexora-task --> on Issue #1       │
                 ▼                                       │
        ┌──────────────────────┐                          │
        │  GitHub Actions cron │  every 15 min           │
        │  (watcher)           │  finds new task comments │
        └──────────┬───────────┘                          │
                   │ workflow_dispatch                     │
                   ▼                                      │
        ┌──────────────────────┐                          │
        │  agent-task run      │  durable, per-task,     │
        │  (artifacts + logs)  │  idempotent             │
        └──────────┬───────────┘                          │
                   │ run URL / evidence                   │
                   └──────────────────────────────────────►│
                                                           │ executes
                                                           │ posts results
                                                           │ back to Issue #1
                                                           ▼
                                                    Issue #1 comments
                                                    (nexora:evidence,
                                                     nexora:blocked,
                                                     nexora:done)
```

### Components

| File | Role |
|---|---|
| `.github/workflows/agent-coordination-watcher.yml` | Scheduled inbound watcher. Finds new `<!-- nexora-task -->` comments on the coordination issue and dispatches one `agent-task` run per task. Idempotent: a task already represented by a run is skipped. |
| `.github/workflows/agent-task.yml` | One durable, idempotent work unit per task. Records task context, fetches the task text, asserts the pinned reference, uploads a transcript artifact. Deliberately contains no project logic. |
| Issue #1 | The task and result bus. Comments are the durable messages. |
| Labels | `nexora:task`, `nexora:review`, `nexora:blocked`, `nexora:evidence`, `nexora:done`. |

### Least privilege

- Both workflows use the automatic repository `GITHUB_TOKEN`, scoped per
  workflow: `contents: read` and, for the watcher only, `issues: write`.
- **No personal access token, key, seed, mnemonic, or credential is stored,
  printed, or required by any of this machinery.**
- The watcher is the only component with write access, and only to issues.
- Nothing is exposed to the public internet; no tunnel, no public listener.

### Secret-handling rules

1. Never place tokens, keys, seeds, mnemonics, or credentials in code, issues,
   PRs, CI logs, or artifacts.
2. Dev/validator keys used in CI are parsed **at runtime** from the unmodified
   upstream `local_node.sh`; they are never committed.
3. If a secret is ever accidentally exposed, treat it as compromised: revoke
   first, then clean up history. The token shared earlier in the owner chat must
   be revoked by the owner — it is compromised by exposure, regardless of
   intent.

---

## 3. What was tested, and what was not

| Claim | Status |
|---|---|
| Watcher scans the issue and finds task markers | **Tested** — see the run linked in the final report. |
| Watcher dispatches an `agent-task` run per new task | **Tested** — an actual dispatch and run were observed. |
| Tasks are idempotent (no duplicate dispatch) | **Tested** — a second watcher pass did not re-dispatch the same comment. |
| Task text is retrievable from the issue by the run | **Tested** — `agent-task` fetches the comment and stores it in its artifact. |
| Results can be posted back to the issue | **Tested** — this report and the phase reports were posted as issue comments. |
| A reviewer can post a task and have it picked up **without** the owner copying anything | **Partially** — the watcher picks it up automatically. But the *execution* of the task still requires an OpenCode session to be running, because no always-on OpenCode agent exists here. |
| ChatGPT can send tasks automatically | **No.** Not possible without a connector, an API key, an always-on host, or a human relay. Documented, not faked. |

### The honest gap

GitHub Actions can *receive* a task unattended, but it cannot *think*. The
reasoning and code changes still come from an OpenCode session. So the current
loop is:

> reviewer → GitHub (automatic pickup) → OpenCode session (executes when it is
> started) → GitHub (automatic evidence) → reviewer.

To close the gap completely, the owner would need to provide one of: an
always-on machine running OpenCode with an authenticated, private tunnel; a
supported OpenCode plugin/MCP bridge; or a scheduler that invokes OpenCode.
None of these can be created from inside this environment, and none are free
without external infrastructure. Everything else in the project proceeds without
them.

---

## 4. Protocol usage

**To file a task (reviewer or owner):**

```markdown
<!-- nexora-task -->
# Short imperative title

What must be true when it is done.
Acceptance criteria.
Constraints (no consensus change, no paid resources, no secrets).
```

**To attach evidence (executor):** comment with the `nexora:evidence` label
containing the commit SHA, CI run URL, artifact ID, and the exact command/output
that proves the claim.

**To block:** comment with `nexora:blocked` and state precisely what authority
or external resource is required.

**To close:** comment with `nexora:done` and the acceptance criteria actually
met, distinguishing clearly between executed, tested, untested, and
resource-blocked work.

---

## 5. Protocol rules

1. Every task is idempotent: re-running it must be safe and must not corrupt
   state.
2. Every claim must be backed by a commit SHA, a CI run URL, or an explicit
   statement that it was *not* verified.
3. CI passing is never evidence of security or production readiness.
4. Absence from a public list is never proof of uniqueness.
5. Distinguish always: executed / tested / untested / blocked.
