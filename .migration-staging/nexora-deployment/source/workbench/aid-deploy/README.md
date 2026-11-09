# workbench/aid-deploy — AID on-chain path (TESTNET ONLY, workbench artifacts)

Date: 2026-11-07 (Africa/Algiers). Isolated loopback local testnet, workbench artifacts only.

## Status: workbench corrected AID artifacts deployed & independently verified on disposable local loopback chain; canonical sources unchanged

**Initial state (pre-broadcast):** No AID contracts were deployed/sent at that time (simulation-only).

**Update (2026-11-07, Task 3 authorized):** A safe loopback-only broadcast was later executed on a *fresh disposable* home (`workbench/aid-deploy/fresh-home-2026-11-07`, chain 902024/0xdc388) using `script/DeployAid.s.sol:DeployAid --sig run() --rpc-url http://127.0.0.1:8545 --broadcast` with `DEPLOYER_PRIVATE_KEY` supplied only via process environment for `forge` (not CLI, not printed, not intentionally written). On-chain deployment/verification evidence is in `workbench/aid-deploy/observations-2026-11-07-broadcast.json` and `workbench/aid-deploy/broadcast/DeployAid.s.sol/902024/run-latest.json`; see broadcast addendum below. Canonical tracked source was not modified; §4.1 correction remains workbench-only.

The earlier pre-broadcast simulation (PID 2688, existing `workbench/local-testnet/home`) remains documented below as historical context; it was not a broadcast. All Task 3 broadcast/verification node processes were stopped and relevant listeners were checked (no 8545/8546/26656/26657/1317/9090 LISTENING observed after stops).

## Critical finding (canonical Registry, SPEC §4.1)

`aid/src/AidRegistry.sol` (canonical, tracked) takes caller-supplied `uint256 chainId` in `register`/`verify` and computes identifiers with it. `aid/SPEC.md` §4.1 requires a contract to read `block.chainid` and verify against a configured constant, failing loudly on mismatch.

**Action taken (workbench only, no tracked edits):**
- Canonical tracked Registry was **not** deployed.
- `workbench/aid-deploy/src/AidRegistry.sol` is a corrected copy: removes caller-supplied `chainId` from `register`/`verify`/mutating paths, reads `block.chainid`, requires `block.chainid == 902024` (`Aid.AidChainMismatch` on mismatch/fork), computes IDs only for the actual chain, exposes `configuredChainId()`.
- `AidFactory` has no chainId/admin/pause semantics and is unaffected; copied unchanged for an auditable artifact set (hash identical to canonical).
- `Aid.sol` copied from canonical plus a workbench-only `AidChainMismatch` error declaration used by the corrected Registry consumer.

## Build / tests

`workbench/aid-deploy` Foundry project (solc 0.8.24, no forge-std/libs):

| Suite | Result | Exit |
|---|---:|---:|
| `forge test` (workbench/aid-deploy) | 48 passed, 0 failed, 0 skipped (AidVector 16, AidFactory 13, AidRegistryCorrected 19) | 0 |

Corrected registry tests explicitly cover: `configuredChainId()==902024`, register/verify on 902024 (no chainId parameter), metadata/type rejection, first-claim-wins, retraction rules, pagination, `vm.chainId(1)`/fork mismatch reverts for register/retract/verify, and caller-spoof regression (foreign-chain ID cannot be registered because the contract uses `block.chainid`).

Canonical/final regression suites (all exit 0):

| Suite | Result |
|---|---:|
| `aid/` `forge test` | 45/45 |
| `aid/` `node --test test/*.test.mjs` | 40/40 |
| `contracts/` `forge test` | 70/70 |
| `market/` `node --test test/*.test.mjs` | 41/41 |
| `workbench/phase6-integration` `node --test` | 85/85 (preserved) |
| `workbench/phase6-market-models` `node --test` | 20/20 |
| `workbench/evm-compat` `node --test` | 8/8 |
| `workbench/nexora-scan` `node --test` | 11/11 |

## Foundry deployment script (broadcast verified on disposable testnet)

`script/DeployAid.s.sol`:
- asserts `block.chainid == 902024`
- reads `DEPLOYER_PRIVATE_KEY` via `vm.envUint` (Foundry script env), **no `--private-key` CLI argument**
- deploys corrected `AidRegistry` and unchanged `AidFactory`
- registers/verifies native AID via `Aid.nativeId(block.chainid)`
- performs deterministic CREATE2 sample (`initCode=0x600a600c600039600a6000f3602a60005260206000f3`, `assetId=bytes32(uint256(0x1111))`, `salt/factory.predict/deploy`, asserts predicted==deployed and `isDeployed`)

### Pre-broadcast simulation (historical; later superseded by verified broadcast below)

Command shape (safe): `forge script script/DeployAid.s.sol:DeployAid --sig run() --rpc-url http://127.0.0.1:8545` with **no `--broadcast`** and **no key CLI arg**.

Key handling for simulation: dev0 test key exported from existing `keyring-test` into a PowerShell variable, normalized to 0x-prefixed hex, assigned to process env `DEPLOYER_PRIVATE_KEY` for the forge process only, then cleared in `finally` (`$env:DEPLOYER_PRIVATE_KEY=$null; $pk/$raw=$null`). The key was **never printed, never written to a file, never passed as a CLI argument, and never re-exported for deployment**. This was a **real-key local simulation only**.

Observed result (`forge-script-sim.log`): **`Script ran successfully. SIMULATION COMPLETE.`** Chain 902024, estimated total gas 1,484,031. **No broadcast. No transactions sent. No addresses/txs created.**

## Unsafe draft (never run)

`deploy-aid.mjs` is marked **UNSAFE DRAFT — DO NOT RUN**. It passed a private key via CLI arguments (`--private-key`/key args to forge/cast). Preserved only as reference; never executed.

## Final regression run — 2026-11-07

The final nine-suite run completed with **368 passed, 0 failed** and exit code 0 for every suite: workbench AID Forge 48, canonical AID Forge 45, AID JavaScript 40, contracts Forge 70, market 41, Phase 6 integration 85, Phase 6 market models 20, EVM compatibility 8, and NEXORA Scan 11. Raw run logs are in `test-results/`.

## SPEC / audit status

`aid/SPEC.md` remains **DRAFT**. Independent Solidity cross-check of all vectors and §10 decisions remain open. The §4.1 implementation issue was corrected only in a workbench testnet artifact; this is not a canonical spec closure. **No security audit claimed.**

## Honest limits

- Workbench §4.1-corrected AID artifacts deployed/verified only on a disposable local loopback chain (not canonical merge, not audited, not production/mainnet).
- 4-validator local consensus drill remains CI-only / outstanding (C3).
- Canonical market merge/review outstanding.
- Market Simulation is a reconstruction, not historical recovered code.
- No public RPC, no Cloudflare/DNS, no commit/push/merge/publish.
- Canonical tracked source not modified. Foundry emitted a “Sensitive values saved” message and wrote cache artifacts; only the 321-byte `cache/DeployAid.s.sol/902024/run-latest.json` file was deleted after schema-only inspection found no private/key-named properties (it contained `transactions[].rpc` and a hex64-like `recovery_generation`; value not printed). Remaining recovery JSONs structurally show no private/key-named properties but hold Foundry recovery metadata/calldata; do not state definitive private-key absence.


## Broadcast addendum — 2026-11-07 (fresh isolated loopback 127.0.0.1:8545, chain 902024)

**Scope/safety:** Fresh home `workbench/aid-deploy/fresh-home-2026-11-07` (separate from `workbench/local-testnet/home`). Loopback verified; `eth_chainId` returned `0xdc388` twice before broadcast. `DEPLOYER_PRIVATE_KEY` provided only as process environment for `forge` (`vm.envUint` in `script/DeployAid.s.sol`), not as a CLI argument, not printed/logged by this session. Node processes started for broadcast/verification were stopped (PID-scoped) and relevant post-stop listeners were checked (no 8545/8546/26656/26657/1317/9090 listeners observed after stops). No public RPC/tunnel/DNS; no commit/push/merge.

**Deployed (verified on-chain, independent `verify_broadcast.py` PASS):**
- AidRegistry (workbench §4.1-corrected): `0x3d641a2791533b4a0000345ea8d509d01e1ec301` (CREATE, tx `0xbfb183377a8f7ecfb53203eca70dff4a8679f2e3ea80a68d60c35e8cdee19e8e`, receipt `0x1`, gas `0xa2572`, logs 0)
- AidFactory (unchanged): `0x07aa076883658b7ed99d25b1e6685808372c8fe2` (CREATE, tx `0x46f878dad3ae07ce02173183f01a762801b1b0518a38160a3aab969197b779ef`, receipt `0x1`, gas `0x4c8fd`, logs 0)
- Registry `register(native)` call: tx `0x7eace5e48596620bdebe04d56055fffe68c802d47fa4acca62f86c7bcca90bdf`, receipt `0x1`, gas `0x16544`, logs 1, to Registry
- Factory CREATE2 `deploy`: tx `0x8e1016b146b34cdd3a5705d96d18f6fa1826b9440903ed4210273b548a666717`, receipt `0x1`, gas `0xf214`, logs 1, to Factory
- CREATE2 instance (predicted == deployed): `0xbd19e1d5c6391ad767b99282af241f8de4b5f508` (bytecode present)
- Native assetId (registry): `0x49d41c535f2cd20369abc4716c440120dd37cdf6aa748555288f6487d8bd5cf6`

**Public getter / verification outputs (safe):** `configuredChainId() = 902024`, `totalRegistrations() = 1`, `isRegistered(native) = true`, `verify(native, 0x00..00) = true`, factory `isDeployed` for the sample CREATE2 salt/init hash = true, predicted address matches instance.

**Why `observations-2026-11-07-broadcast.json` originally recorded `status: PARTIAL`:** `forge` broadcast exited 0 and the broadcast artifact was written, but the orchestrator’s post-broadcast parsing/verification did not populate contract identification fields (it recorded empty `parsed_addresses`/`parsed_txhashes` and no `registry_*`/`create2_*` probe results in that pass). The on-chain state is independently verified by `workbench/aid-deploy/verify_broadcast.py` (`PASS`), and the evidence file was updated to `BROADCAST_SUCCESS_VERIFIED`.

**Foundry “Sensitive values saved” cache finding (2026-11-07):** Forge reported `Sensitive values saved to .../cache/DeployAid.s.sol/902024/run-latest.json`. A schema-only inspection (no values read/printed) of that file and related `cache/**`/`broadcast/**` 902024 artifacts found **no property names matching private/secret/key/mnemonic/env/DEPLOYER_PRIVATE_KEY**. The deleted 321-byte `cache/DeployAid.s.sol/902024/run-latest.json` contained only `transactions[].rpc` (URL strings) and a hex64-like `recovery_generation` field (value not printed). Remaining recovery JSON files structurally show no private/key-named properties but hold Foundry recovery metadata/calldata (and related broadcast artifacts contain expected tx hashes, receipts, addresses, calldata/input, fingerprints, attempts/payload hashes, generation IDs). **Action taken:** only the 321-byte `cache/.../902024/run-latest.json` was deleted; `observations-2026-11-07-broadcast.json` and broadcast tx artifacts were preserved. **Honest limit:** Foundry emitted the sensitive-values warning and cache artifacts existed on disk; schema-only inspection is not proof that no secret material was ever encoded in any non-obvious field. **Do not state definitive private-key absence.** No `unsafe-export`/re-export was performed; no broadcast was re-run.

**Remaining gaps:** Canonical AID Registry §4.1 fix not merged (C2); `aid/SPEC.md` DRAFT; independent review/audit open; 4-validator local drill CI-only (C3); chain-ID naming conflict C1 unresolved.
