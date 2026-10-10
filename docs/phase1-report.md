# NEXORA Phase 1 Report

**Date:** 2026-10-10
**Repository:** `lolsmoo911-bit/NEXORA` (public), branch `main`
**Phase 1 Status:** ✅ COMPLETE (accepted with actual execution results)

## Objective
Build and run the unmodified cosmos/evm reference chain v0.7.3, verify JSON-RPC, and deploy/call a simple Solidity contract. All work performed on GitHub Actions (Ubuntu 24.04), at $0 budget, with no modifications to the upstream reference code.

## Commit and Branch
- **Commit used:** `515d0705988fccc5ea2774c3b29bd0257ded78ee`
- **Branch:** `main`
- **Scope note:** Both files `contracts/foundry.toml` and `contracts/src/NexoraGreeter.sol` exist in the HEAD commit's tree.

## Upstream Reference (Pinned, Unmodified)
- **Repo:** https://github.com/cosmos/evm
- **Tag:** `v0.7.3`
- **Pinned commit:** `c3ae9067a7eadcdea55a5192226916deb44c71c4`
- **Verification:** `test "$(git rev-parse HEAD)" = "c3ae9067a7eadcdea55a5192226916deb44c71c4"` — passed.

## Environment and Toolchain
- **CI Runner:** GitHub Actions `ubuntu-24.04`
- **Go:** `1.25.9` (installed via `actions/setup-go@v5`)
- **evmd:** built from pinned commit via `make install` (unmodified build; no code changes)
- **Foundry:** `forge Version: 1.8.5` (installed via `foundry-rs/foundry-toolchain@v1`)
- **jq:** `1.7`

## Execution Evidence (GitHub Actions)
- **Run:** [#38016004413](https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38016004413) — `conclusion: success`
- **All steps:** succeeded (Build evmd, Install Foundry, Run Phase 1 verification, Upload transcripts).
- **Artifact:** `phase1-transcripts` (ID: `11656990775`, size 10340 bytes)
  - Download URL: https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38016004413/artifacts/11656990775

All quoted values below are extracted directly from the successful run's job logs.

## JSON-RPC Verification
- `eth_chainId`: `0x40000` (Expected: `0x40000` = 262144; matches `DefaultEVMChainID = 262144` in upstream `server/config/config.go`)
- `net_version`: `262144`
- `web3_clientVersion`: `Version dev ()\nCompiled at  using Go go1.25.9 (amd64)`
- Block production: `eth_blockNumber` advanced `0x1 → 0x4` (after +3s). Block numbers were sampled until non-null and verified to advance.
- Node startup: upstream `local_node.sh -y --no-install` used unmodified; JSON-RPC reachable in ~5s.

## Accounts and Balances (Test Environment Only)
- **dev0 (Cosmos):** `cosmos1cml96vmptgw99syqrrz8az79xer2pcgp95srxm` (genesis-funded, upstream test account)
- **dev0 (EVM balance):** `0x3635c9adc5dea00000`
- **Cosmos balances (denom `atest`):** `1000000000000000000000`

**Important:** These are upstream test keys/accounts for a temporary local node. No production keys, no mainnet, no external network used.

## Solidity Contract Build, Deploy, and Call
- **Contract:** `contracts/src/NexoraGreeter.sol` — `greet() returns "Hello NEXORA"` (contract code unchanged)
- **Foundry build:** `forge build` — `Compiler run successful!` (two compilation passes observed; clean build)
- **Deployment:** `forge create` succeeded (after correcting `--constructor-args` to be the last flag; script fix only, contract unchanged)
- **Deployed address:** `0x3D641a2791533B4A0000345eA8d509d01E1ec301`
- **Call result:** `cast call ... greet()(string)` → `"Hello NEXORA"`
- **Code prefix (first bytes):** `0x608060405234801561000f575f5ffd5b5060043610610034575f3560e01c8063a413686214610038...`

## CI Script Fixes (Targeted, Necessary)
Only `ci/verify-reference-chain.sh` was modified in commit `515d070`:
- Fixed `forge create` ordering: `--constructor-args` moved to be the last flag for both attempts (first and `--legacy` retry). This directly resolved "Constructor argument count mismatch: expected 1 but got 7".
- Improved `eth_blockNumber` sampling: poll until non-null (max 30s), then wait +3s, and explicitly assert block numbers advance (`BN2 > BN1`) using `jq`.

No reference code (`cosmos/evm`), no consensus/dependency changes, and no changes to `contracts/` or `NexoraGreeter.sol`.

## Transcript Files (All Recorded)
`ci-artifacts/` includes: `node.log`, `eth_chainId.json`, `net_version.json`, `web3_clientVersion.json`, `eth_blockNumber-1.json`, `eth_blockNumber-2.json`, `dev0-address.txt`, `dev0-balances.json`, `dev0-evm-balance.json`, `forge-build.log`, `deploy.log`, `contract-address.txt`, `greet.txt`, `contract-code.txt`, `evmd-version.txt`, `forge-version.txt`, `jq-version.txt`.

## Acceptance Criteria (Met)
- [x] Reproducible build from clean checkout (on CI, unmodified upstream). 
- [x] Node starts via upstream `local_node.sh -y --no-install` and produces blocks.
- [x] JSON-RPC answers match deterministic expectations (`eth_chainId=0x40000`, `net_version=262144`).
- [x] Solidity contract builds, deploys, and is callable; `greet()` returns `Hello NEXORA`.
- [x] All results recorded in run logs and uploaded artifacts; no unsubstantiated claims.
- [x] No mainnet, no production keys, no paid resources. Test environment only.

## Notes on Environment
The node and all transactions ran in a temporary CI environment (ephemeral). It was not a persistent public network. Any state (keys, chain data) existed only for the duration of the verification job.

**Conclusion:** Phase 1 is COMPLETE by actual verification.