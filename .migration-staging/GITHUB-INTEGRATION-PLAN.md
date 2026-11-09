# GitHub Integration Preparation — NEXORA / Replit

**Phase:** Phase 4 — Inspection and plan only. No Git writes performed.
**Created:** 2026-11-09
**Workspace:** `/home/runner/workspace`

---

## 1. Git Architecture

### 1.1 Root repository

| Item | Value |
|---|---|
| Path | `/home/runner/workspace/.git` |
| HEAD | `332d875c927f8a77208806fa08383afe7b0ddf53` |
| Branch | `main` |
| Remotes | `gitsafe-backup` → `git://gitsafe:5418/backup.git` (fetch + push) |
| No `origin` remote | The root repo has **no** remote pointing to GitHub NEXORA |
| Tracked top-level | `artifacts`, `lib`, `.foundry`, `.keys`, `scripts`, `.replit`, `package.json`, etc. (Replit scaffold) |
| Untracked project files | `source/`, `tools/`, `apps/`, `docs/`, `README.md`, `opencode.json`, `scripts/README.md` |

### 1.2 Snapshot repository (metadata gone)

| Item | Value |
|---|---|
| Path | `/home/runner/workspace/.migration-staging/replit-transfer-20261108` |
| `.git` | **absent** (removed during/after server restart) |
| Expected branch | `replit-transfer-20261108` |
| Expected HEAD | `0b3b41fe82a87de36a091f9cfd2eea542c6c8a6b` |
| Remote HEAD (verified) | `0b3b41fe82a87de36a091f9cfd2eea542c6c8a6b` ✅ matches |
| Remote URL | `https://github.com/lolsmoo911-bit/NEXORA.git` |

### 1.3 Nested repositories (in backup)

| Repo | Path | HEAD | Remote | Status |
|---|---|---|---|---|
| NEXORA | `nexora-chain/NEXORA` (now in backup) | `9201fe8` | `origin https://github.com/lolsmoo911-bit/NEXORA.git` | clean, 596 behind main |
| cosmos-evm | `nexora-chain/cosmos-evm` (now in backup) | `c3ae906` (detached) | `origin https://github.com/cosmos/evm.git` | clean |

### 1.4 Shared history

- Root commit `931346f` is **NOT** in the NEXORA repository (verified via `git cat-file`).
- The root workspace and NEXORA repository are **separate repositories with no shared history**.
- The snapshot commit `0b3b41f` IS in the NEXORA repository (verified via `git cat-file -t`).
- `merge-base` between root `931346f` and snapshot `0b3b41f` fails — no common ancestor.

### 1.5 Conclusion

The root workspace repository and the NEXORA repository are **independent**. The root repo tracks Replit-specific files (scaffold, secrets, artifacts, `.foundry`). The NEXORA repo tracks the project code. They do not share history.

---

## 2. Project tracking strategy

### 2.1 Files that SHOULD be tracked in GitHub

These are the actual project source files from the snapshot (now in workspace root):

| Path | Files | Notes |
|---|---:|---|
| `source/` | 357 | NEXORA project (aid, bridge, chain, ci, contracts, deployments, docs, experiments, market, scripts, testnet, .github, .vanity, workbench) |
| `tools/` | 43 | opencode-bridge, proxy-grabber, cloudflare-edge, secure-file-handoff |
| `apps/` | 51 | market-data-hub (Python) |
| `docs/` | 13 | Foundation docs, decision log, status, plans |
| `scripts/README.md` | 1 | New (existing 6 scripts are Replit runtime) |
| `README.md` | 1 | NEXORA canonical workspace README |
| `opencode.json` | 1 | OpenCode permissions config |

**Total project files to track:** ~469

### 2.2 Files that MUST be excluded (local-only / sensitive)

| Pattern | Reason |
|---|---|
| `.migration-staging/` | Backup, staging, plans — local only |
| `.foundry/` | Binaries (294M) — re-downloadable |
| `.config/` | OpenCode CLI + npm global + secrets |
| `.local/` | OpenCode DB, sessions, snapshots (9.2G) |
| `.keys/` | Private keys |
| `*.addr`, `.gol.salt`, `.npmrc`, `.p3.json`, `.p4.json`, `.p3.txt`, `.p4.txt` | Secrets/credentials |
| `.vanity_initcode.hex`, `.vanity_ich.txt` | Vanity address data |
| `node_modules/` | Dependencies (reinstallable) |
| `.cache/` | Build caches |
| `.venv/` | Python virtual environments |
| `nexora-chain/` | Chain binaries, state, nested repos (too large) |
| `nexora-docs/` | Mirrored docs (tracked in NEXORA repo) |
| `artifacts/` | Build outputs (regenerable) |
| `lib/` | Replit scaffold packages |
| `bin/` | cloudflared binary |
| `.replit`, `replit.md` | Replit-specific (local only) |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig*.json` | Replit scaffold |
| `nexora-rpc-gateway.mjs` | Old standalone gateway (tracked in NEXORA repo) |
| `.replitignore` | Replit-specific |
| `cfurl.txt`, `cf.log` | Runtime data |
| `dev` | Empty file |

### 2.3 `.gitignore` merge strategy

The current `.gitignore` has Replit rules + NEXORA chain/docs ignores + the snapshot's handoff ignore. For GitHub tracking, a separate `.gitignore` should be created that combines:

1. **NEXORA project ignores** (from main's `.gitignore`): `build/`, `*.exe`, `*.out`, `bin/`, `~/.osd/`, `~/.nexorad/`, `data/`, `*.pid`, `.env`, `**/keys/`, `**/priv_validator_key.json`, `**/*.key`, `node_modules/`, `vendor/`, `.idea/`, `.vscode/`, `.DS_Store`, `contracts/out/`, `contracts/cache/`, `contracts/lib/`
2. **Snapshot handoff ignore**: `/tools/secure-file-handoff/var/`
3. **Replit-specific ignores** (if tracking Replit files): `.cache/`, `.local/`, `.config/`

**Recommendation:** Keep the Replit `.gitignore` as-is for the workspace, and create a separate `.gitignore` in the NEXORA repo (or use `source/.gitignore` from the snapshot) for the project code.

---

## 3. Safest GitHub integration method

### Option A: Preserve snapshot history (continue from `replit-transfer-20261108`)

- **How:** Add the NEXORA remote to the workspace, fetch the branch, and continue committing on top of `0b3b41f`.
- **Pros:** Preserves all existing NEXORA history; clean lineage.
- **Cons:** The root workspace repo and NEXORA repo have no shared history. Would require either (a) making the root repo a clone of NEXORA (losing Replit-specific files) or (b) maintaining two separate repos.
- **Verdict:** Not directly applicable — the root workspace is a different repository.

### Option B: Create a new deployment branch based on the snapshot

- **How:** Create a new branch in the NEXORA repo (e.g., `replit-deployment`) from `replit-transfer-20261108`, add Replit-specific adaptations, push to GitHub.
- **Pros:** Clean separation; preserves snapshot history; can be updated incrementally.
- **Cons:** Requires the NEXORA repo to be accessible from Replit (it's in backup now).
- **Verdict:** **Recommended.** This is the safest approach.

### Option C: Integrate selected workspace changes without rewriting history

- **How:** Use `git format-patch` or manual file copying to apply workspace changes to the NEXORA repo.
- **Pros:** No history rewrite.
- **Cons:** Manual, error-prone, loses atomicity.
- **Verdict:** Not recommended for this scale.

### Recommendation: Option B

1. Restore the NEXORA repo from backup (or use the existing clone).
2. Create a new branch: `git checkout -b replit-deployment replit-transfer-20261108`
3. Apply Replit-specific adaptations (`.replit` integration, path adjustments, etc.) as new commits.
4. Push to GitHub: `git push origin replit-deployment`
5. For future updates: `git pull origin replit-transfer-20261108` then merge/rebase into `replit-deployment`.

**How to update and push later:**
```bash
cd nexora-chain/NEXORA
git fetch origin
git checkout replit-deployment
git merge origin/replit-transfer-20261108  # or rebase
# make changes
git add <specific files>
git commit -m "description"
git push origin replit-deployment
```

---

## 4. Cloudflare Tunnel Status

### Current configuration

| Item | Value |
|---|---|
| Tunnel type | **Quick Tunnel** (temporary) — `cloudflared tunnel --url http://127.0.0.1:8085` |
| Current URL | `https://anonymous-vessels-profiles-skins.trycloudflare.com` (changes on restart) |
| Previous URL | `https://flows-counter-charitable-clinical.trycloudflare.com` |
| Named tunnel | **None configured** — no `config.yml`, no `cert.pem`, no tunnel credentials |
| Custom domain | **Not configured** |
| Watchdog | `scripts/opencode-web-watchdog.sh` — self-healing loop, restarts components every 10s |
| cloudflared binary | `/home/runner/workspace/bin/cloudflared` v2026.10.0 |

### What is still needed for a stable 24/7 URL

1. **Create a named tunnel:** `cloudflared tunnel create nexora-opencode` (requires Cloudflare account login)
2. **Configure DNS:** Point a custom domain (e.g., `opencode.nexora.io`) to the tunnel via Cloudflare DNS
3. **Create `config.yml`:** Map the hostname to `http://127.0.0.1:8085`
4. **Run as service:** `cloudflared tunnel run nexora-opencode` (or as a systemd service)
5. **Update watchdog:** Change `start_tunnel()` to use the named tunnel instead of `--url`
6. **Persist credentials:** Store tunnel credentials in a secure location (not in Git)

**Current limitation:** Quick Tunnels (`trycloudflare.com`) are ephemeral — the URL changes on every restart and they are not suitable for production. They also have rate limits and no SLA.

---

## 5. Recommended next steps (not executed)

1. **Restore NEXORA repo from backup** to a working location for Git operations.
2. **Create deployment branch:** `git checkout -b replit-deployment replit-transfer-20261108`
3. **Set up `.gitignore`** for the NEXORA repo (merge main's project ignores + Replit ignores + handoff ignore).
4. **Register forge-std** as a proper submodule (rev `f3dae6e6...`).
5. **Reconcile Testnet** state (epoch 632 from main).
6. **Stage and commit** project files (source/, tools/, apps/, docs/, scripts/README.md, README.md, opencode.json).
7. **Push** to GitHub: `git push origin replit-deployment`
8. **Set up named Cloudflare tunnel** for stable URL.

### Exact commands to begin (when approved)

```bash
# 1. Restore NEXORA repo from backup
cp -a .migration-staging/old-project-backup/nexora-chain/NEXORA /tmp/nexora-repo  # or a worktree

# 2. Create deployment branch
cd /tmp/nexora-repo
git checkout -b replit-deployment replit-transfer-20261108

# 3. Apply Replit adaptations
# (copy tools/, apps/, docs/ from snapshot; adjust paths)
# (merge .gitignore)
# (register forge-std submodule)

# 4. Stage and commit
git add source/ tools/ apps/ docs/ scripts/README.md README.md opencode.json
git commit -m "feat: stage NEXORA for Replit deployment"

# 5. Push
git push origin replit-deployment
```

---

## 6. Strict compliance

- No staging, committing, pushing, resetting, rebasing, or remote changes performed.
- No backup deleted.
- No Testnet data modified.
- No OpenCode configuration, database, or sessions touched.
- No dependencies installed.
- No secrets exposed.
- Only `GITHUB-INTEGRATION-PLAN.md` was created in this phase.

**Plan complete. Awaiting approval to execute.**
