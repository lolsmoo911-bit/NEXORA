# Replit Migration Handoff (NEXORA safe snapshot)

This document describes the staged migration snapshot prepared on the `replit-migration-staging` branch. It contains **no credentials, private keys, certificates, seeds, OAuth/session databases, raw OpenCode session transcripts, or runtime secrets**.

## 1. OpenCode in Replit Shell
- **OpenCode already exists in the Replit Shell and must be retained.**
- Migration **must not reinstall or reconfigure OpenCode** in Replit.
- This snapshot does not copy local OpenCode installation, configuration, runtime state, or session databases.

## 2. Repository layout / component distinction
- **Root `NEXORA-ANEX-REBUILT` foundation material** (`apps/`, `docs/`, `scripts/`, selected manifests, root docs) is distinct from the **nested `source/` chain prototype/workbench**.
- **Keep this distinction.** `source/` contains the original NEXORA repository tree (code/docs/tests) as a nested repository snapshot; root-level material is the broader rebuilt workspace foundation.
- **NEXORA `source/bridge`** (inside the nested chain/source tree) is **not** the same as the separate **`tools/opencode-bridge`** (ChatGPT/OpenCode bridge copied from `C:\Users\Administrator\opencode-bridge`, safe source/docs/manifests only).

## 3. Phase 6 latest Windows test evidence
- **Latest Windows test evidence (Phase 6): 368 passed, 0 failed across nine suites.**
- This is **test evidence only, not production readiness**.

## 4. Open items / non-readiness
- **Chain ID mismatch:** `nexora-devnet-1` vs `eip155:902024` remains unresolved.
- **Canonical AID Registry still accepts caller-provided `chainId`** (workbench fix not merged into the canonical path reflected here).
- **4-validator local Windows verification not done** (CI evidence only).
- **AID SPEC still DRAFT / no independent audit.**
- **Canonical market merge/review open.**
- **No public RPC/Cloudflare exposure. No production-readiness claim.**

## 5. Network/testnet state preserved from GitHub
- The latest GitHub network state is **epoch 605** and **must be preserved over local epoch 580**.
- This snapshot preserves the GitHub branch `source/testnet/ledger.json` and `source/testnet/state.json` from **epoch 605** (verified during staging; local epoch-580 copies were not used to overwrite them).

## 6. Component distinctions
- **NEXORA `source/bridge`** = bridge code inside the nested NEXORA source tree.
- **`tools/opencode-bridge`** = separate ChatGPT/OpenCode bridge utility (safe subset only).
- **`tools/proxy-grabber`** = proxy discovery/route/stability tooling source (safe subset only).
- **`tools/cloudflare-edge`** = Cloudflare edge staging source/tests/examples (safe subset only; no live edge exposure created).

## 7. Proxy grabber and WARP safety
- **Proxy grabber is for non-sensitive tests only.**
- **Never send private source, credentials, tokens, cookies, or sensitive data through public proxies.**
- **WARP for OpenCode remains separate and is not currently active.** Do not route private OpenCode/LLM traffic through public proxies.

## 8. Windows service/toolchain handling
- **Windows service wrappers and toolchains must be handled/rebuilt for Linux/Replit.**
- This snapshot **does not copy Windows executables, service binaries/configs, WinSW artifacts, or local toolchains**. Linux/Replit compatibility work is a later step.

## 9. Replit backup status
- **Replit pre-migration backup is NOT verified.**
- **Do not replace the existing Replit workspace files until the backup is verified.** Updating the Replit workspace is a later step after backup confirmation.

## Snapshot scope notes
- Safe source/docs/manifests/scripts were staged; secrets, credentials, certificates, keys, databases, runtime logs/state, caches, toolchains, large binaries (>45 MiB), and Windows service/runtime artifacts were excluded.
- No Git LFS setup was performed. No packages were installed. No tunnels/RPC endpoints were created or altered.
