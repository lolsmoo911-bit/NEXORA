# CLEAN PROJECT REPLACEMENT PLAN — NEXORA / Replit

**Phase:** Inspection and plan only. No deletion, move, overwrite, install, commit, or push performed.
**Created:** 2026-11-09
**Workspace:** `/home/runner/workspace`
**Snapshot:** `/home/runner/workspace/.migration-staging/replit-transfer-20261108`
**Snapshot commit:** `0b3b41fe82a87de36a091f9cfd2eea542c6c8a6b`
**GitHub main:** `25f372d52d67d07028d4fbc4cceed6fca7e3e0de` (NEXORA, epoch 632)

---

---

## 0. Authoritative source (EXPLICIT)

| Item | Value |
|---|---|
| Repository | `lolsmoo911-bit/NEXORA` |
| Branch | `replit-transfer-20261108` |
| URL | `https://github.com/lolsmoo911-bit/NEXORA/tree/replit-transfer-20261108` |
| Expected commit | `0b3b41fe82a87de36a091f9cfd2eea542c6c8a6b` |
| Remote verified | ✅ `git ls-remote` returns `0b3b41fe82a87de36a091f9cfd2eea542c6c8a6b` |
| Snapshot files | 374 tracked files, 6.7M (with `.git`) |
| `.git` in staging | **absent** (removed during/after server restart) |
| Clean tree at clone time | yes (verified before `.git` disappeared) |

**This branch is the authoritative source for the new NEXORA project, its tools, apps, and docs.**
GitHub `main` is used **only** for independently verified newer content (Testnet epoch 632, README, docs/STATUS.md).

---

## 1. Replacement boundaries

### 1.1 Old NEXORA project (to archive, not delete yet)

| Path | Size | Type | Notes |
|---|---:|---|---|
| `nexora-chain/` | 1.4G | directory | Old chain runtime + nested repos + testnet data |
| `nexora-chain/NEXORA/` | 8.6M | nested Git repo | NEXORA project at epoch 30, 596/602 commits behind main |
| `nexora-chain/cosmos-evm/` | 173M | nested Git repo | detached HEAD `c3ae9067a7eadcdea55a5192226916deb44c71c4` |
| `nexora-chain/testnet/` | 1.3G | runtime data | 4 validators, logs, state DBs, PIDs |
| `nexora-chain/data/` | 0 | empty | |
| `nexora-docs/` | 184K | documentation | Mirrored NEXORA docs |
| `nexora-rpc-gateway.mjs` | 8K | standalone gateway | Keep during replacement; archive only after validation |

Total old-project footprint to archive: approximately **1.4G + 184K + 8K**.

### 1.2 New project (from snapshot commit `0b3b41f`)

The snapshot is a reorganized NEXORA project. Its top-level layout:

| Path | Files | Notes |
|---|---:|---|
| `source/` | 285 | Wrapped NEXORA project (`aid`, `bridge`, `chain`, `ci`, `contracts`, `deployments`, `docs`, `experiments`, `market`, `scripts`, `testnet`, `.github`, `.vanity`, `workbench`) |
| `tools/` | 42 | `opencode-bridge`, `proxy-grabber`, `cloudflare-edge`, `secure-file-handoff` |
| `apps/` | 30 | `market-data-hub` (Python) |
| `docs/` | 13 | Foundation docs, decision log, status, plans |
| `scripts/` | 1 | `README.md` |
| `opencode.json` | 1 | OpenCode permissions/config |
| `README.md` | 1 | NEXORA canonical workspace README |
| `.gitignore` | 1 | Private handoff ignore (`/tools/secure-file-handoff/var/`) |
| `source/.gitmodules` | 1 | declares `contracts/lib/forge-std` |

Total new project tracked files: **374**, size **3.5MB** (excluding `.git`).

### 1.3 Intended final directory layout

```text
/home/runner/workspace/
  .replit
  replit.md
  .config/                      # OpenCode + npm global (PRESERVE)
  .local/                       # OpenCode DB, sessions, snapshots (PRESERVE)
  .foundry/                     # Foundry binaries (PRESERVE)
  .keys/                        # Secrets (PRESERVE, never print)
  bin/                          # cloudflared (PRESERVE)
  artifacts/                    # Replit runtime (api-server, mockup-sandbox) (PRESERVE)
  lib/                          # Replit scaffold packages (PRESERVE)
  scripts/                      # Replit runtime scripts + new README.md
  package.json, pnpm-lock.yaml, pnpm-workspace.yaml, tsconfig*.json
  nexora-rpc-gateway.mjs        # Keep during replacement
  cfurl.txt, cf.log (if present)
  .gitignore                    # Merged rules
  opencode.json                 # NEW
  README.md                     # NEW (NEXORA canonical)
  source/                       # NEW NEXORA project
  tools/                        # NEW tools
  apps/                         # NEW apps
  docs/                         # NEW docs
  .migration-staging/
    old-project-backup/
      nexora-chain/
      nexora-docs/
    newer-testnet-epoch632/
      ledger.json
      state.json
    replit-transfer-20261108/   # snapshot source
    TRANSFER-VERIFY.md
    MERGE-PLAN.md
    CLEAN-REPLACEMENT-PLAN.md
```

### 1.4 Nested Git repositories and submodules

| Path | Type | HEAD / Rev | Notes |
|---|---|---|---|
| `/home/runner/workspace/.git` | Git repo | `332d875` | Root workspace |
| `nexora-chain/NEXORA/.git` | Git repo | `9201fe8` | NEXORA project (behind main) |
| `nexora-chain/cosmos-evm/.git` | Git repo | `c3ae906` (detached) | cosmos/evm upstream |
| `source/contracts/lib/forge-std/.git` | **broken gitlink** | points to `source/.git/modules/...` (nonexistent) | Content matches rev `f3dae6e6...` |
| `source/.gitmodules` | submodule declaration | declares forge-std | No root `.gitmodules` |

No submodules are currently registered in the root repository.

---

## 2. Authoritative source determination

### 2.1 Comparison: snapshot branch vs GitHub main

Command: `git -C nexora-chain/NEXORA diff --no-renames --name-status FETCH_HEAD..origin/main` (FETCH_HEAD = snapshot commit `0b3b41f`, origin/main = `25f372d`)

Non-testnet result: **0 commits with code changes**. Only 3 modified files:

| File | Change |
|---|---|
| `.gitignore` | snapshot has 2 lines; main has 44 lines (project ignores) |
| `README.md` | 249 insertions, 119 deletions (main is newer) |
| `docs/STATUS.md` | modified (main is newer) |

Testnet result: main has **6963 insertions** (epoch 605 → 632, +22 epochs).

The snapshot reorganizes the NEXORA project under `source/` (all files are `R100` renames from main's root layout). The snapshot also adds `tools/`, `apps/`, `docs/`, `scripts/README.md`, `opencode.json`, and a new `README.md`.

### 2.2 Authoritative source per component

| Component | Authoritative source | Reason |
|---|---|---|
| Replit runtime/config (`artifacts/`, `lib/`, `package.json`, `tsconfig*`, `.replit`, `replit.md`, `scripts/*` except README) | **Current workspace** | Replit-specific, must not be replaced |
| OpenCode CLI/config/DB/sessions | **Current workspace** | Must survive replacement |
| Secrets (`.keys/`, `.npmrc`, `.gol.salt`, `.p3/.p4`, `*.addr`) | **Current workspace** | Never move or expose |
| `.foundry/` binaries | **Current workspace** | Replit toolchain |
| `nexora-rpc-gateway.mjs` | **Current workspace** (keep initially) | May be used by undocumented workflows |
| NEXORA core code (`source/aid`, `source/bridge`, `source/chain`, `source/ci`, `source/contracts`, `source/market`, `source/deployments`) | **Snapshot `source/`** (identical to main) | Same content, reorganized under `source/` |
| NEXORA `README.md` | **GitHub main** | Main has 249 more lines |
| NEXORA `.gitignore` | **Merge** (main's project ignores + Replit ignores + snapshot's handoff ignore) | All three have different rules |
| NEXORA `docs/STATUS.md` | **GitHub main** | Main is newer |
| Testnet state (`ledger.json`, `state.json`) | **GitHub main (epoch 632)** | 27 epochs newer than snapshot (605) |
| `tools/` (opencode-bridge, proxy-grabber, cloudflare-edge, secure-file-handoff) | **Snapshot** | New in snapshot, absent from main |
| `apps/` (market-data-hub) | **Snapshot** | New in snapshot, absent from main |
| `docs/` (foundation architecture, decision log, etc.) | **Snapshot** | New in snapshot, absent from main |
| `scripts/README.md` | **Snapshot** | New |
| `opencode.json` | **Snapshot** | OpenCode permissions config |
| `forge-std` (rev `f3dae6e6...`) | **Existing local copy** | Same rev, no network needed |
| Old chain runtime (`nexora-chain/testnet/` node data) | **Current workspace** (archive) | Preserve for rollback |
| Old NEXORA docs (`nexora-docs/`) | **Current workspace** (archive) | Preserve for reference |

### 2.3 Key conclusion

The snapshot is **not** newer in code — its `source/` content is byte-identical to GitHub main (all `R100` renames). The snapshot's value is the **Replit-oriented reorganization** (wrapping under `source/`, adding `tools/`, `apps/`, `docs/`, `opencode.json`). GitHub main is newer only in Testnet state (epoch 632 vs 605) and two docs (README, STATUS). The snapshot is the correct base for the Replit migration, with Testnet state taken from main.

---

## 3. Items that must survive replacement

### 3.1 OpenCode and Replit (never touch)

| Item | Path |
|---|---|
| OpenCode CLI | `.config/npm/node_global/bin/opencode` (v2.2.6) |
| OpenCode config | `.config/opencode/service.json` |
| OpenCode database | `.local/share/opencode/opencode.db` (32M) |
| OpenCode sessions/snapshots | `.local/share/opencode/` (9.2G) |
| OpenCode Web | port 8080 (watchdog) |
| OpenCode service | port 49374 |
| Replit config | `.replit`, `replit.md` |
| Watchdog script | `scripts/opencode-web-watchdog.sh` |
| Keep-alive script | `scripts/keep-opencode-alive.sh` |
| Post-merge script | `scripts/post-merge.sh` |

### 3.2 Replit runtime (keep)

| Item | Path |
|---|---|
| API server | `artifacts/api-server/` (5.2M) |
| Mockup sandbox | `artifacts/mockup-sandbox/` |
| Replit scaffold packages | `lib/` (336K) |
| Foundry binaries | `.foundry/` (294M) |
| Cloudflare binary | `bin/cloudflared` (39M) |
| Package config | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig*.json` |

### 3.3 Secrets and sensitive files (never move or expose)

| Item | Path |
|---|---|
| Keys | `.keys/` (64K) |
| npm config | `.npmrc` |
| Salt | `.gol.salt` |
| Phase configs | `.p3.json`, `.p3.txt`, `.p4.json`, `.p4.txt` |
| Addresses | `*.addr` files (`.b3.addr`, `.buyer1.addr`, `.buyer2.addr`, `.dep2.addr`, `.deployer.addr`, `.dev1.addr`, `.dev2.addr`, `.dev3.addr`, `.registry.addr`, `.token.addr`, `.val1.addr`, `.val2.addr`, `.vault.addr`) |
| Vanity data | `.vanity_initcode.hex`, `.vanity_ich.txt` |

### 3.4 Newer Testnet state (preserve, do not overwrite)

| Item | Source | Epoch | Notes |
|---|---|---:|---|
| `testnet/ledger.json` | GitHub main | 632 | 20212 cumulative blocks |
| `testnet/state.json` | GitHub main | 632 | app_hash `59B06BE2...` |
| `nexora-chain/testnet/` (runtime) | Current workspace | — | 4 validators, 1.3G, node data |

### 3.5 Existing local forge-std

| Item | Path | Rev |
|---|---|---|
| forge-std | `/home/runner/workspace/nexora-chain/NEXORA/contracts/lib/forge-std` | `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` (v1.17.0) |

---

### forge-std/.git inspection (READ-ONLY)

- `source/contracts/lib/forge-std/.git` is a **regular file** (gitlink), not a directory.
- Content: `gitdir: ../../../.git/modules/contracts/lib/forge-std`
- Resolved target: `source/.git/modules/contracts/lib/forge-std` — **does not exist** (because `source/` is not a git repository).
- The gitlink is **broken** in the workspace copy.
- The actual git objects live in: `/home/runner/workspace/nexora-chain/NEXORA/.git/modules/contracts/lib/forge-std`
- The existing local NEXORA copy's `.git` is also a gitlink file (same content), pointing to its own `.git/modules/`.
- **Do not blindly copy** the `.git` file — it would carry a broken relative path. Instead, copy the actual `.git` **directory** from `nexora-chain/NEXORA/.git/modules/contracts/lib/forge-std` into `source/contracts/lib/forge-std/.git` (replacing the gitlink file).

## 4. Backup and rollback procedure

### 4.1 Pre-replacement backup (before any move)

```bash
set -e
BASE=/home/runner/workspace
BACKUP="$BASE/.migration-staging/old-project-backup"
mkdir -p "$BACKUP"

# Back up .gitignore
cp "$BASE/.gitignore" "$BACKUP/.gitignore.pre-replacement"

# Back up newer Testnet state from GitHub main (already fetched)
mkdir -p "$BASE/.migration-staging/newer-testnet-epoch632"
git -C "$BASE/nexora-chain/NEXORA" show origin/main:testnet/ledger.json > "$BASE/.migration-staging/newer-testnet-epoch632/ledger.json"
git -C "$BASE/nexora-chain/NEXORA" show origin/main:testnet/state.json > "$BASE/.migration-staging/newer-testnet-epoch632/state.json"
sha256sum "$BASE/.migration-staging/newer-testnet-epoch632/"*

# Move old project (NOT delete)
mv "$BASE/nexora-chain" "$BACKUP/nexora-chain"
mv "$BASE/nexora-docs" "$BACKUP/nexora-docs"

# Keep nexora-rpc-gateway.mjs initially; archive copy only
cp "$BASE/nexora-rpc-gateway.mjs" "$BACKUP/nexora-rpc-gateway.mjs.keep"
```

### 4.2 Rollback (if replacement fails)

```bash
set -e
BASE=/home/runner/workspace
BACKUP="$BASE/.migration-staging/old-project-backup"

# Restore old project
mv "$BACKUP/nexora-chain" "$BASE/nexora-chain"
mv "$BACKUP/nexora-docs" "$BASE/nexora-docs"
cp "$BACKUP/.gitignore.pre-replacement" "$BASE/.gitignore"

# Restore Testnet state if it was overwritten
# cp "$BASE/.migration-staging/newer-testnet-epoch632/ledger.json" "$BASE/source/testnet/ledger.json"
# (only if source/testnet was modified)

echo "Rollback complete"
```

### 4.3 Verification after rollback

```bash
cd /home/runner/workspace
git status --short --branch
ls nexora-chain nexora-docs
opencode --version
opencode service status
```

---

## 5. Testnet state preservation

### Testnet consistency verification (READ-ONLY)

Verified that both Testnet pairs are internally consistent (same chain `eip155:902024`):

| Source | Epoch | Height | App Hash | Ledger↔State match |
|---|---:|---:|---|---|
| Snapshot `source/testnet/` | 605 | 32 | `E6BE368D...` | ✅ appHash and height match |
| GitHub main | 632 | 29 | `59B06BE2...` | ✅ appHash and height match |
| Local NEXORA repo | 30 | 34 | `763A59B1...` | ✅ appHash and height match |

**Conclusion:** Both snapshot and main Testnet pairs are internally consistent. GitHub main (epoch 632) is the newer, authoritative state. Snapshot (epoch 605) must not overwrite it.

### Current state

| Source | Epoch | Height | App Hash |
|---|---:|---:|---|
| Snapshot `source/testnet/` | 605 | 32 | `E6BE368D...` |
| GitHub main | 632 | 29 | `59B06BE2...` |
| Local NEXORA repo | 30 | 34 | `763A59B1...` |

### Procedure

1. **Before replacement:** Extract GitHub main's Testnet files to `.migration-staging/newer-testnet-epoch632/` (read-only extraction, no fetch needed — `origin/main` is already fetched).
2. **After replacement:** Copy the newer Testnet files over `source/testnet/`:
   ```bash
   cp .migration-staging/newer-testnet-epoch632/ledger.json source/testnet/ledger.json
   cp .migration-staging/newer-testnet-epoch632/state.json source/testnet/state.json
   ```
3. **Verify:** `node -e "const l=require('./source/testnet/ledger.json'); console.log('epoch:',l.epoch,'appHash:',l.appHash)"`
4. **Expected result:** epoch 632, app_hash `59B06BE2...`
5. **Never** overwrite with snapshot's epoch 605 files after this step.
6. The runtime validator data in `nexora-chain/testnet/` is moved to backup (preserved, not deleted).

---

## 6. Dependency restoration plan

To be executed only after successful file replacement and validation:

| Component | Command | Location |
|---|---|---|
| Replit scaffold | `pnpm install` | `/home/runner/workspace` |
| `source/aid` | `npm install --no-audit --no-fund` | `source/aid/` |
| `tools/opencode-bridge` | `npm install --no-audit --no-fund` | `tools/opencode-bridge/` |
| `tools/cloudflare-edge` | (no dependencies) | — |
| `apps/market-data-hub` | (Python stdlib only) | — |
| `forge-std` | Copy `.git` from existing local copy (no network) | `source/contracts/lib/forge-std/` |
| Go chain | `go mod download` (network, if building) | `source/chain/` |

**Order:** Replit scaffold first, then source/aid, then tools/opencode-bridge, then forge-std gitdir fix.

**Note:** `node_modules` was removed during cleanup. Reinstall is required before `pnpm run typecheck` or `pnpm run build`.

---

## 7. Validation and startup tests

### 7.1 Structure validation

```bash
cd /home/runner/workspace
git status --short --branch
git fsck --no-progress
find source tools apps docs scripts -type f | wc -l
git diff --check
```

### 7.2 OpenCode / Replit validation

```bash
opencode --version
opencode service status
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080
sqlite3 /home/runner/workspace/.local/share/opencode/opencode.db 'PRAGMA integrity_check;'
```

### 7.3 Replit config validation

```bash
cat /home/runner/workspace/.replit
ls -l /home/runner/workspace/replit.md
ls -l /home/runner/workspace/scripts/opencode-web-watchdog.sh
```

### 7.4 Bridge tests

```bash
cd /home/runner/workspace/source/bridge && node --test test/*.test.mjs
cd /home/runner/workspace/tools/opencode-bridge && node scripts/core-test.mjs
```

Expected: source/bridge 76 pass, 0 fail; opencode-bridge 14 pass, 2 fail (Linux path tests — known, not a failure).

### 7.5 Optional lightweight tests (no install)

```bash
cd /home/runner/workspace/tools/cloudflare-edge && node --test test/*.test.mjs
cd /home/runner/workspace/tools/secure-file-handoff && python3 -m unittest discover -s tests
cd /home/runner/workspace/apps/market-data-hub && python3 -m unittest discover -s tests
```

### 7.6 Contracts dependency check

```bash
test -d /home/runner/workspace/source/contracts/lib/forge-std && echo "forge-std present" || echo "forge-std MISSING"
cat /home/runner/workspace/source/contracts/foundry.lock
```

### 7.7 Testnet state validation

```bash
cd /home/runner/workspace
node -e "const l=require('./source/testnet/ledger.json'); console.log('epoch:',l.epoch,'height:',l.height,'cumulative:',l.cumulativeBlocks,'appHash:',l.appHash)"
node -e "const s=require('./source/testnet/state.json'); console.log('height:',s.height,'app_hash:',s.app_hash)"
```

Expected: epoch 632, app_hash `59B06BE2...`.

### 7.8 Build validation (after dependency restoration)

```bash
cd /home/runner/workspace
pnpm install
pnpm run typecheck
cd source/aid && npm install --no-audit --no-fund && npm run test:only
cd /home/runner/workspace/tools/opencode-bridge && npm install --no-audit --no-fund
```

### 7.9 Forge build (optional, after forge-std gitdir fix)

```bash
cd /home/runner/workspace/source/contracts
forge build
```

---

## 8. Final cleanup steps (only after successful validation)

### 8.1 After validation succeeds

```bash
# 1. Remove old project backup (only after explicit approval)
# rm -rf /home/runner/workspace/.migration-staging/old-project-backup

# 2. Remove snapshot clone (only after validation)
# rm -rf /home/runner/workspace/.migration-staging/replit-transfer-20261108

# 3. Remove candidate files
# rm -f /home/runner/workspace/.migration-staging/.gitignore.snapshot-candidate

# 4. Update .gitignore to ignore backup/staging
# echo '/.migration-staging/old-project-backup/' >> /home/runner/workspace/.gitignore
# echo '/.migration-staging/newer-testnet-epoch632/' >> /home/runner/workspace/.gitignore

# 5. Regenerate Manifest (optional)
# cd /home/runner/workspace && node scripts/generate-manifest.mjs 2>/dev/null || echo "no generator"
```

### 8.2 Do NOT remove

- `.migration-staging/TRANSFER-VERIFY.md`
- `.migration-staging/MERGE-PLAN.md`
- `.migration-staging/CLEAN-REPLACEMENT-PLAN.md`
- `.config/`, `.local/`, `.foundry/`, `.keys/`
- `nexora-rpc-gateway.mjs` (until confirmed redundant)

---

## 9. Practical replacement sequence (exact commands)

```bash
set -e
BASE=/home/runner/workspace
BACKUP="$BASE/.migration-staging/old-project-backup"

# === PREFLIGHT ===
cd "$BASE"
git rev-parse HEAD                                    # expect 332d875...
git branch --show-current                            # expect main
grep -c -F '/tools/secure-file-handoff/var/' .gitignore  # expect 1
opencode --version
opencode service status
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080
sqlite3 "$BASE/.local/share/opencode/opencode.db" 'PRAGMA integrity_check;'

# === BACKUP OLD PROJECT ===
mkdir -p "$BACKUP"
cp "$BASE/.gitignore" "$BACKUP/.gitignore.pre-replacement"

# Extract newer Testnet state (read-only, no fetch needed)
mkdir -p "$BASE/.migration-staging/newer-testnet-epoch632"
git -C "$BASE/nexora-chain/NEXORA" show origin/main:testnet/ledger.json > "$BASE/.migration-staging/newer-testnet-epoch632/ledger.json"
git -C "$BASE/nexora-chain/NEXORA" show origin/main:testnet/state.json > "$BASE/.migration-staging/newer-testnet-epoch632/state.json"
sha256sum "$BASE/.migration-staging/newer-testnet-epoch632/"*

# Move old project (NOT delete)
mv "$BASE/nexora-chain" "$BACKUP/nexora-chain"
mv "$BASE/nexora-docs" "$BACKUP/nexora-docs"
cp "$BASE/nexora-rpc-gateway.mjs" "$BACKUP/nexora-rpc-gateway.mjs.keep"

# === APPLY NEWER TESTNET STATE ===
cp "$BASE/.migration-staging/newer-testnet-epoch632/ledger.json" "$BASE/source/testnet/ledger.json"
cp "$BASE/.migration-staging/newer-testnet-epoch632/state.json" "$BASE/source/testnet/state.json"

# === VERIFY TESTNET ===
node -e "const l=require('$BASE/source/testnet/ledger.json'); console.log('epoch:',l.epoch,'appHash:',l.appHash)"
# Expected: epoch: 632

# === FIX forge-std GITDIR ===
rm -f "$BASE/source/contracts/lib/forge-std/.git"
cp -a "$BASE/.migration-staging/old-project-backup/nexora-chain/NEXORA/.git/modules/contracts/lib/forge-std" "$BASE/source/contracts/lib/forge-std/.git"
# Verify: git -C source/contracts/lib/forge-std rev-parse HEAD -> f3dae6e6...

# === VALIDATE ===
cd "$BASE"
git status --short --branch
git fsck --no-progress
find source tools apps docs scripts -type f | wc -l
git diff --check
opencode --version
opencode service status
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080
sqlite3 "$BASE/.local/share/opencode/opencode.db" 'PRAGMA integrity_check;'
cd source/bridge && node --test test/*.test.mjs
cd "$BASE/tools/opencode-bridge" && node scripts/core-test.mjs
test -d "$BASE/source/contracts/lib/forge-std" && echo "forge-std present" || echo "forge-std MISSING"

# === DEPENDENCY RESTORATION (after validation) ===
cd "$BASE"
pnpm install
cd "$BASE/source/aid" && npm install --no-audit --no-fund
cd "$BASE/tools/opencode-bridge" && npm install --no-audit --no-fund
cd "$BASE" && pnpm run typecheck
```

---

## 10. Authoritative source summary

| Component | Authoritative source | Reason |
|---|---|---|
| Replit runtime/config | Current workspace | Replit-specific |
| OpenCode CLI/config/DB/sessions | Current workspace | Must survive |
| Secrets | Current workspace | Never move/expose |
| Replit scaffold (`artifacts/`, `lib/`, `package.json`, etc.) | Current workspace | Replit-specific |
| NEXORA core code | Snapshot `source/` (identical to main) | Same content, reorganized |
| NEXORA `README.md` | GitHub main | 249 more lines |
| NEXORA `.gitignore` | Merge (main + Replit + snapshot handoff) | Different rules |
| NEXORA `docs/STATUS.md` | GitHub main | Newer |
| Testnet state | GitHub main (epoch 632) | 27 epochs newer |
| `tools/`, `apps/`, `docs/`, `opencode.json` | Snapshot | New in snapshot |
| `forge-std` | Existing local copy (rev `f3dae6e6`) | Same rev, no network |
| Old chain runtime/testnet | Current workspace (archive) | Preserve for rollback |
| Old NEXORA docs | Current workspace (archive) | Preserve for reference |

---

## 11. Strict compliance

- No deletion, move, overwrite, install, commit, or push performed during this phase.
- No OpenCode runtime data, Replit configuration, or Testnet state touched.
- No secrets exposed or copied.
- Only `CLEAN-REPLACEMENT-PLAN.md` was created in this phase.
- The `.gitignore` change from Phase 2A remains untouched.

**Plan complete. Awaiting approval to execute.**
