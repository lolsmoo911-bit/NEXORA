# MERGE PLAN — NEXORA migration into Replit workspace

**Phase:** Phase 1 audit (READ-ONLY). No merge performed by this audit.
**Created:** 2026-11-09
**Workspace:** `/home/runner/workspace`
**Snapshot (staging):** `/home/runner/workspace/.migration-staging/replit-transfer-20261108`
**Transfer report:** `/home/runner/workspace/.migration-staging/TRANSFER-VERIFY.md`

---

## 0. Audit metadata

- Snapshot remote: `https://github.com/lolsmoo911-bit/NEXORA.git`
- Expected branch: `replit-transfer-20261108`
- Remote branch SHA: `0b3b41fe82a87de36a091f9cfd2eea542c6c8a6b` (verified via `git ls-remote`)
- Snapshot files present in staging: 374
- Snapshot size: 6.7M (with `.git` originally; staging now lacks `.git`)
- Secret scan: no `.env`, `.key`, `.pem` files in snapshot; only `tools/opencode-bridge/.env.example`. No secret values read or copied.
- Classification method: SHA-256 comparison of every snapshot file against its intended workspace destination (same relative path). Verified by Python script.

### Anomaly 1: Replit Agent auto-commit (root Git state changed)

The workspace Git state changed during this migration without an explicit merge:

- Previous root HEAD: `931346fc4128f77eee982b076a5abbfd7fc0c83f`
- Current root HEAD: `332d875c927f8a77208806fa08383afe7b0ddf53`
- Author: `Replit Agent <agent@replit.com>`
- Commit message: `Install Foundry binaries and add migration verification documentation`
- Effect: all 375 `.migration-staging/...` files are now tracked in the root repository, and the snapshot's `.git` directory is gone.
- This audit did **not** create that commit. No further Git writes were performed by this audit.
- Recommendation: decide later whether to keep, revert, or squash this auto-commit. Do not use `git reset --hard`.

### Anomaly 2: Snapshot files already copied to workspace root

The snapshot's content files (`source/`, `tools/`, `apps/`, `docs/`, `opencode.json`, `README.md`, `scripts/README.md`) are already present in `/home/runner/workspace/` (untracked, timestamps 2026-11-08 22:25). This means a copy already occurred (likely by Replit Agent). The `.gitignore` was **not** updated (conflict resolved in Phase 2A). The `forge-std` dependency was copied as a plain directory (not a git submodule, and its `.git` gitlink is broken).

---

## 1. Verified source and destination Git states

### Source (snapshot, metadata partially unavailable)

| Item | Value |
|---|---|
| Remote | `https://github.com/lolsmoo911-bit/NEXORA.git` |
| Branch | `replit-transfer-20261108` |
| Expected HEAD | `0b3b41fe82a87de36a091f9cfd2eea542c6c8a6b` |
| Remote HEAD | `0b3b41fe82a87de36a091f9cfd2eea542c6c8a6b` (verified via `git ls-remote`) |
| `.git` in staging | **absent** (removed during/after server restart; files remain intact) |
| Clean tree at clone time | yes (verified before `.git` disappeared) |
| Current staging status | cannot be re-verified without `.git` |

### Destination: root workspace

| Item | Value |
|---|---|
| Path | `/home/runner/workspace` |
| HEAD | `332d875c927f8a77208806fa08383afe7b0ddf53` (Replit Agent auto-commit) |
| Branch | `main` |
| Status | 4 pre-existing untracked Foundry binaries + untracked snapshot files (`source/`, `tools/`, `apps/`, `docs/`, `opencode.json`, `README.md`, `scripts/README.md`, `.migration-staging/...`) + ` M .gitignore` (Phase 2A) |
| Tracked top-level | `artifacts`, `lib`, `.foundry`, `.keys`, `scripts`, plus `.migration-staging` |

### Destination: nested NEXORA repository

| Item | Value |
|---|---|
| Path | `/home/runner/workspace/nexora-chain/NEXORA` |
| HEAD | `9201fe8372aeaadc297e1110b93443264cb4af54` |
| Branch | `main` |
| Status | clean |
| Remote | `origin https://github.com/lolsmoo911-bit/NEXORA.git` |
| Remote main | `25f372d52d67d07028d4fbc4cceed6fca7e3e0de` (epoch 632, 596 commits ahead of local) |

### Destination: nested cosmos-evm repository

| Item | Value |
|---|---|
| Path | `/home/runner/workspace/nexora-chain/cosmos-evm` |
| HEAD | `c3ae9067a7eadcdea55a5192226916deb44c71c4` |
| Branch | detached HEAD |
| Status | clean |
| Remote | `origin https://github.com/cosmos/evm.git` |

### OpenCode / Replit protection (must remain untouched)

| Item | Path / Value |
|---|---|
| OpenCode CLI | `/home/runner/workspace/.config/npm/node_global/bin/opencode` (`v2.2.6`) |
| OpenCode config | `/home/runner/workspace/.config/opencode/service.json` |
| OpenCode database | `/home/runner/workspace/.local/share/opencode/opencode.db` (32M, integrity ok) |
| OpenCode Web | `http://127.0.0.1:8080` (not responding after server restart — not caused by this audit) |
| OpenCode service | `http://127.0.0.1:49374` |
| Replit config | `/home/runner/workspace/.replit`, `replit.md` |
| Watchdog | `/home/runner/workspace/scripts/opencode-web-watchdog.sh` |

These were not modified by this audit.

---

## 2. File-level migration inventory

Mapping rule: snapshot relative path -> same relative path under `/home/runner/workspace`.

Classification was performed by SHA-256 comparison of every snapshot file against its intended workspace destination.

| Classification | Count | Notes |
|---|---:|---|
| ADD | 0 | All 374 snapshot files already present in workspace |
| IDENTICAL | 373 | SHA-256 matches between snapshot and workspace |
| CONFLICT | 1 | `.gitignore` differs (resolved in Phase 2A — line appended) |
| WORKSPACE-ONLY | 79 | 73 forge-std files + 6 existing Replit scripts files |
| MISSING-DEPENDENCY | multiple | See section 6 |

### ADD (0 files)

No snapshot file is absent from the workspace. All 374 snapshot files are already present.

### IDENTICAL (373 files)

All snapshot files except `.gitignore` are byte-identical to their workspace counterparts. This includes:
- `opencode.json`, `README.md` (2)
- `apps/` (30)
- `docs/` (13)
- `scripts/README.md` (1)
- `source/` (285)
- `tools/` (42)

### CONFLICT (1 file — resolved in Phase 2A)

- `.gitignore`
  - Workspace version is the original Replit template (54 lines) plus NEXORA-specific ignores.
  - Snapshot version is 2 lines: `# Private one-time handoff material` + `/tools/secure-file-handoff/var/`.
  - **Resolution:** Appended `/tools/secure-file-handoff/var/` to the existing `.gitignore` (Phase 2A). All existing Replit ignore rules preserved. Line appears exactly once. `git diff --check` = 0.

### WORKSPACE-ONLY (79 files, must be preserved)

**forge-std (73 files)** — copied from existing local NEXORA copy into `source/contracts/lib/forge-std/`:
- `.git` (gitlink file pointing to `../../../.git/modules/contracts/lib/forge-std` — **broken**, target does not exist)
- `.gitattributes`, `.gitignore`, `CONTRIBUTING.md`, `LICENSE-APACHE`, `LICENSE-MIT`, `README.md`, `RELEASE_CHECKLIST.md`
- `.github/CODEOWNERS`, `.github/dependabot.yml`, `.github/workflows/*`
- `scripts/vm.py`
- `src/*.sol` (20+ files)
- `test/*.t.sol` (10+ files)
- `test/compilation/*`, `test/fixtures/*`

**Existing Replit scripts (6 files)** — must be preserved:
- `scripts/package.json`
- `scripts/tsconfig.json`
- `scripts/post-merge.sh`
- `scripts/keep-opencode-alive.sh`
- `scripts/opencode-web-watchdog.sh`
- `scripts/src/hello.ts`

### MISSING-DEPENDENCY

1. **`source/contracts/lib/forge-std`** — declared in `source/.gitmodules`:
   - path: `contracts/lib/forge-std`
   - url: `https://github.com/foundry-rs/forge-std`
   - required rev: `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` (tag `v1.17.0`, per `source/contracts/foundry.lock`)
   - The directory is **absent** from the snapshot (Manifest also lists 117 missing forge-std files).
   - **Resolved (already done):** An exact matching copy exists at `/home/runner/workspace/nexora-chain/NEXORA/contracts/lib/forge-std` at rev `f3dae6e6...` and was copied into `source/contracts/lib/forge-std/` as a plain directory (not a git submodule). The content is byte-identical to the existing local copy (`diff -rq` shows no differences).
   - **Issue:** The `.git` file inside the copy is a gitlink pointing to `../../../.git/modules/contracts/lib/forge-std`, which resolves to `source/.git/modules/contracts/lib/forge-std` — this path does not exist because `source/` is not a git repository. The gitlink is **broken**. The actual git objects live in `/home/runner/workspace/nexora-chain/NEXORA/.git/modules/contracts/lib/forge-std`.
   - To fix: either copy the actual `.git` directory from the NEXORA copy, or reinitialize the submodule. No network fetch needed.

2. **`tools/opencode-bridge` dependencies** — not installed:
   - `@modelcontextprotocol/sdk` ^1.32.1
   - `@opencode/client` ^2.1.2
   - `zod` ^4.6.7

3. **`source/aid` dependencies** — `js-sha3` 0.9.3 (npm)

4. **`apps/market-data-hub`** — Python standard library only (no requirements file present)

---

## 3. Exact proposed destination paths

| Snapshot path | Proposed destination | Action |
|---|---|---|
| `.gitignore` | `/home/runner/workspace/.gitignore` | **MERGED** (Phase 2A — line appended) |
| `opencode.json` | `/home/runner/workspace/opencode.json` | Already present (IDENTICAL) |
| `README.md` | `/home/runner/workspace/README.md` | Already present (IDENTICAL) |
| `apps/` | `/home/runner/workspace/apps/` | Already present (IDENTICAL) |
| `docs/` | `/home/runner/workspace/docs/` | Already present (IDENTICAL) |
| `scripts/README.md` | `/home/runner/workspace/scripts/README.md` | Already present (IDENTICAL) |
| `source/` | `/home/runner/workspace/source/` | Already present (IDENTICAL) |
| `tools/` | `/home/runner/workspace/tools/` | Already present (IDENTICAL) |

No snapshot file maps into `artifacts/`, `lib/`, `nexora-chain/`, `nexora-docs/`, `.config/`, `.local/`, `.replit`, or `replit.md`.

**Note:** The snapshot files have already been copied into the workspace root (likely by Replit Agent). The only remaining work is:
1. Register or verify `forge-std` as a proper submodule (currently a broken gitlink)
2. Reconcile Testnet state (epoch 605 vs 632)
3. Update the stale Manifest
4. Run validation

---

## 4. Safe merge order

1. Confirm OpenCode/Replit health before any change:
   - `opencode --version`
   - `opencode service status`
   - `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080`
   - `sqlite3 /home/runner/workspace/.local/share/opencode/opencode.db 'PRAGMA integrity_check;'`
2. Merge `.gitignore` manually (add only `/tools/secure-file-handoff/var/`). **DONE in Phase 2A.**
3. Register `forge-std` dependency without network fetch:
   - Option A: copy actual `.git` directory from `/home/runner/workspace/nexora-chain/NEXORA/contracts/lib/forge-std` into `source/contracts/lib/forge-std/.git` (replacing the broken gitlink).
   - Option B: initialize submodule to the pinned rev if local objects are available.
   - Do not run `forge install` or any network operation.
4. Preserve Replit/OpenCode files. Do not touch:
   - `.replit`, `replit.md`, `.config/opencode/`, `.local/share/opencode/`, `.local/state/opencode-web/`, `scripts/opencode-web-watchdog.sh`, `scripts/keep-opencode-alive.sh`, `scripts/post-merge.sh`
5. Do not replace Testnet state. See section 5.
6. Run validation commands from section 8.
7. Only after validation, consider Git tracking/commit strategy.

---

## 5. Testnet epoch 605 vs 632 findings

### Evidence

| Source | Epoch | Height | Cumulative blocks | App hash | Commit |
|---|---:|---:|---:|---|---|
| Snapshot `source/testnet/ledger.json` | 605 | 32 | 19348 | `E6BE368D9FDEC52BE1E946A9FE3BE5B54FB37CFE0EE3DA819BE9DACC209C59EB` | `ffef93b` |
| Snapshot `source/testnet/state.json` | 605 | 32 | — | `E6BE368D9FDEC52BE1E946A9FE3BE5B54FB37CFE0EE3DA819BE9DACC209C59EB` | `ffef93b` |
| GitHub `main` `testnet/ledger.json` | 632 | 29 | 20212 | `59B06BE2FBBA11731A3F671434AD322BC036AD808A69FA072E3AF2F6AC25AAB8` | `25f372d` |
| Local nested NEXORA `testnet/ledger.json` | 30 | 34 | 966 | `763A59B1F4C76A3635106B76E88FEB9F75B1EDAA87E143C45CD006F62D56D7F8` | `9201fe8` (596 behind main) |

Chain identity in all available evidence: `eip155:902024` / NEXORA testnet.

### Findings

1. The snapshot is **27 epochs behind GitHub `main`** (605 vs 632).
2. The local nested NEXORA repository is **far behind** (epoch 30), so it is not the newer state.
3. Heights differ slightly (32 vs 29), and app hashes differ, so these are not interchangeable states.
4. The snapshot's Testnet state is not newer than GitHub `main`.

### Safe reconciliation recommendation

- **Do not overwrite or roll back** any newer Testnet state.
- Because `source/testnet/` is already present (IDENTICAL to snapshot), importing is complete. It should be treated as **epoch 605 baseline**, not current.
- After the merge, reconcile `source/testnet/` with GitHub `main` epoch 632 in a separate, explicitly approved step (compare ledger/state by epoch and app hash; preserve the higher epoch).
- Do not copy snapshot Testnet files over the local `nexora-chain/NEXORA/testnet/` files.
- Do not modify the nested NEXORA repository during this merge.

---

## 6. `forge-std` findings

- Required by `source/.gitmodules`:
  - path: `contracts/lib/forge-std`
  - url: `https://github.com/foundry-rs/forge-std`
  - required rev: `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` (tag `v1.17.0`, per `source/contracts/foundry.lock`)
- Snapshot status: **MISSING-DEPENDENCY** — `source/contracts/lib/forge-std` was absent from the snapshot.
- Manifest also lists 117 missing forge-std files.
- **Resolved (already done):** An exact matching copy exists at `/home/runner/workspace/nexora-chain/NEXORA/contracts/lib/forge-std` at rev `f3dae6e6...` and was copied into `source/contracts/lib/forge-std/` as a plain directory (not a git submodule). The content is byte-identical to the existing local copy (`diff -rq` shows no differences).
- **Issue:** The `.git` file inside the copy is a gitlink pointing to `../../../.git/modules/contracts/lib/forge-std`, which resolves to `source/.git/modules/contracts/lib/forge-std` — this path does not exist because `source/` is not a git repository. The gitlink is **broken**. The actual git objects live in `/home/runner/workspace/nexora-chain/NEXORA/.git/modules/contracts/lib/forge-std`.
- To fix: either copy the actual `.git` directory from the NEXORA copy, or reinitialize the submodule. No network fetch needed.

---

## 7. Tool test results

### `source/bridge`

- Command: `cd .migration-staging/replit-transfer-20261108/source/bridge && node --test test/*.test.mjs`
- Dependencies: none
- Result: **76 pass, 0 fail** (~358ms, ~682ms on re-run)

### `tools/opencode-bridge`

- Command: `cd .migration-staging/replit-transfer-20261108/tools/opencode-bridge && node scripts/core-test.mjs`
- Result: **14 pass, 2 fail**
- The two failures are Linux-environment specific:
  1. `withinRoots rejects drive escapes (C:/..)` — missing expected `WorkspaceError`
  2. `withinRoots rejects UNC paths` — missing expected `WorkspaceError`
- These are Windows-path tests on Linux and are **not** counted as passed.
- `test:proxy` and integration tests were not run because dependencies are absent and installation is prohibited.

---

## 8. Validation commands after migration

```bash
cd /home/runner/workspace

# Git / structure
git status --short --branch
git fsck --no-progress
find source tools apps docs scripts -type f | wc -l
git diff --check

# OpenCode / Replit
opencode --version
opencode service status
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080
sqlite3 /home/runner/workspace/.local/share/opencode/opencode.db 'PRAGMA integrity_check;'

# Bridge tests
cd source/bridge && node --test test/*.test.mjs
cd /home/runner/workspace/tools/opencode-bridge && node scripts/core-test.mjs

# Optional lightweight tests (no install)
cd /home/runner/workspace/tools/cloudflare-edge && node --test test/*.test.mjs
cd /home/runner/workspace/tools/secure-file-handoff && python3 -m unittest discover -s tests
cd /home/runner/workspace/apps/market-data-hub && python3 -m unittest discover -s tests

# Contracts dependency check
test -d source/contracts/lib/forge-std && echo "forge-std present" || echo "forge-std MISSING"
```

---

## 9. Exact next commands to begin the safe merge

The snapshot files are already in the workspace root. The remaining work is:

```bash
cd /home/runner/workspace

# 1. Register forge-std as a proper submodule (optional, recommended)
# git submodule add https://github.com/foundry-rs/forge-std source/contracts/lib/forge-std
# git -C source/contracts/lib/forge-std checkout f3dae6e6ee381f25eb6a246f7da9b85c91a68219

# 2. Reconcile Testnet (separate step, preserve higher epoch)
# Compare source/testnet/ledger.json (epoch 605) with GitHub main (epoch 632+)
# Keep the higher epoch; do not overwrite newer state

# 3. Run validation (section 8)
```

After running, execute the validation commands in section 8.

---

## 10. Risks

- Replit Agent auto-commit (`332d875`) changed root HEAD and tracked all staging files without an explicit merge.
- Snapshot `.git` metadata is missing, so clean-tree verification cannot be repeated locally; remote HEAD matches.
- Snapshot Testnet is 27 epochs behind GitHub `main`; merge must not overwrite newer state.
- `forge-std` is present as a plain directory copy with a broken gitlink, not a registered submodule.
- `tools/opencode-bridge` has 2 environment-specific test failures on Linux.
- Manifest counts are stale (489 vs 374) and must not be used as authoritative.
- `.gitignore` conflict resolved in Phase 2A (line appended).
- OpenCode Web (8080) is currently not responding after server restart (not caused by this audit).

---

## 11. Summary

| Metric | Value |
|---|---|
| Snapshot files | 374 |
| ADD (before copy) | 373 |
| IDENTICAL (current) | 373 |
| CONFLICT (resolved) | 1 (`.gitignore` — Phase 2A) |
| WORKSPACE-ONLY | 79 (73 forge-std + 6 scripts) |
| MISSING-DEPENDENCY | forge-std (resolved as plain copy with broken gitlink), node_modules deps |
| source/bridge tests | 76 pass, 0 fail |
| tools/opencode-bridge tests | 14 pass, 2 fail (Linux path tests) |
| OpenCode | v2.2.6, DB ok, Web not responding (transient) |
| Testnet | snapshot epoch 605, main epoch 632 (27 behind) |

**No merge, no deletion, no installation was performed by this audit. Only `MERGE-PLAN.md` was created/updated.**
