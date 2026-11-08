# Phase 3 — 4-validator consensus/fault/recovery reproduction plan (Windows-aware)

**Date:** 2026-11-07. **Historical status:** Phase 3 multi-validator CI passed (Actions #38179431126). **Local status on this host:** **NOT RUN / NOT LOCALLY VERIFIED** (C3). Do not claim local 4-validator consensus/fault/recovery evidence.

## Why local reproduction is blocked on this Windows/LocalSystem host
- WSL unavailable: `WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED` (observed). Canonical multi-node scripts (`ci/phase3/gen4-genesis.sh`, `run-4validators.sh`, per-node homes/ports) are bash-oriented and assume Linux-like process/network semantics.
- Running 4 `evmd` instances on Windows requires careful isolation: distinct homes under a fresh `workbench/` path, non-colliding P2P/RPC/gRPC/API/pprof/Prometheus ports (all loopback `127.0.0.1`), separate genesis/gentx handling, PID-scoped cleanup, and no writes to `testnet/state.json`/`ledger.json` or `workbench/local-testnet/home`.
- `localhost` DNS issues observed on this host; configs must bind `127.0.0.1` explicitly (lesson from Task 1).

## Reproducible CI plan (preferred)
1. **Runner:** `ubuntu-latest` (or pinned Linux matching existing Phase 2/3 CI), with Go/evmd toolchain pinned to repo/CI versions (`cosmos/evm` `c3ae9067`, Go 1.25.x as per CI).
2. **Genesis:** `PARAMS_FILE=chain/nexora-devnet.json COSMOS_EVM_DIR=<checkout> bash ci/phase3/gen4-genesis.sh <fresh_home> <out_dir>` (or CI workflow equivalent). Record genesis SHA256, validator count (4), chain IDs (Cosmos `eip155:902024`, EVM 902024/0xdc388).
3. **Start 4 validators:** use `ci/phase3/run-4validators.sh` / workflow steps; bind services to loopback in CI job context; capture PIDs/logs as artifacts.
4. **Consensus checks:** all 4 nodes produce blocks; heights advance; app hashes/heights agree across validators at sampled heights (RPC/status queries). Record block numbers + hashes.
5. **Fault injection:** stop validator 1 process (PID-scoped); verify remaining validators maintain consensus and chain advances (>=N blocks) with 3/4 voting power if configured accordingly; capture evidence.
6. **Recovery:** restart validator 1 from its existing home; verify it catches up to current height and app hash matches peers; capture catch-up duration/height delta.
7. **Teardown:** stop all 4 PIDs; verify no listeners on test ports. Upload logs, genesis hash, sampled heights/hashes, fault/recovery transcript as CI artifacts.
8. **Pass criteria:** deterministic genesis (if script claims determinism), 4-node consensus before fault, liveness after 1-node stop, successful resync/rejoin, no canonical config edits.

## Windows-safe local drill (only if explicitly authorized later)
- Create `workbench/phase3-4val-windows/<timestamp>/home{1..4}` fresh; never touch existing homes.
- Port plan (example, verify free): node1 RPC 8545/P2P 26656/API 1317/gRPC 9090; node2 8555/26666/1327/9100; node3 8565/26676/1337/9110; node4 8575/26686/1347/9120 (all `127.0.0.1`).
- Adapt `gen4-genesis.sh`/`genesis_win.py` logic carefully for 4 validators; validate each home/genesis; start sequentially, connect persistent peers, wait for valid block production on all.
- Run minimal fault/recovery (stop node4 PID, confirm progress, restart, confirm catch-up). PID-scoped cleanup only; `netstat` verify all chosen ports closed.
- **Risk:** Windows CometBFT/evmd multi-process behavior and port/file locking may differ; treat as best-effort local evidence, not CI-equivalent unless fully matching checks pass.

## Honest reporting
- Report as **CI-VERIFIED ONLY** until either CI rerun artifacts are captured in this cycle or a Windows-safe drill completes with full consensus/fault/recovery evidence. Current cycle: local 4-validator not run on this host.