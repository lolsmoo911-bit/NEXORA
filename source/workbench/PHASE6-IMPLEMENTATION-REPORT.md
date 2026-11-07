# Phase 6 — implementation report (EVM/RPC + local testnet)

Date: 2026-11-07 (Africa/Algiers). Session host: Windows + LocalSystem shell,
Node `C:\Program Files\nodejs\node.exe` v24.22.1, Python 3.13.7.

## 1. What this document covers (and what it does not)

This report covers **this session's tract**: the local EVM toolchain +
testnet + Phase 5 contract checks + the EVM/RPC compatibility and gas
package. The parallel session owns `workbench/phase6-market-models`
(credit spreads, FX, crypto scenarios, Market Simulation, state
migration, benchmarks); those modules are **not duplicated here**, and the
pre-existing `workbench/phase6-integration` (ACT/ACT ICMA + curve
bootstrap, 85/85) is **preserved untouched**.

No tracked source modified. No commit/push/merge (no `git` binary on this
host's PATH at all; see §7). Foundry emitted a “Sensitive values saved” cache warning during the later authorized local AID broadcast. The cache inspection and cleanup are documented in §13; it is not possible to prove that no secret material was ever stored in an opaque cache field. The test identity was used only on the disposable loopback chain. No key values were printed in this report. No
Cloudflare/tunnel change and no public RPC. Test listeners are loopback-only
and stopped at the end of
this session (see §8; the testnet home remains under `workbench/` for
restart).

## 2. ROADMAP Phase 6 exit criteria — status map

Canonical list from `ROADMAP.md` Phase 6 (+ "Remaining in this phase"):

| Criterion | Status after this session | Evidence |
|---|---|---|
| ACT/ACT ICMA | DONE (workbench, not canonical) | `workbench/phase6-integration` 85/85, preserved |
| Curve bootstrapping from par yields | DONE (workbench) | same |
| Credit spreads | OWNED BY PARALLEL SESSION | not built here |
| FX and crypto models | OWNED BY PARALLEL SESSION | not built here |
| EVM/RPC compatibility matrix | DONE (workbench + live) | `workbench/evm-compat` 8/8; `observations-2026-11-07.json` |
| Gas accounting | DONE (model + live) | `workbench/evm-compat/src/gas.mjs`; live: gasUsed 476045, effectiveGasPrice 1, estimateGas 0x5dc0 |
| Fuzz | DONE (evm-compat probe fuzz-adjacent; market fuzz exists) | probe against closed-port + fake-upstream tests; integration fuzz preserved |
| State migration | OWNED BY PARALLEL SESSION | — |
| Benchmark script + real results on named hardware | OWNED BY PARALLEL SESSION | — |
| Running Phase 5 contracts on the NEXORA chain | **PARTIAL → workbench AID verified on disposable local loopback (Task 3, §13); canonical merge outstanding** | NexoraGreeter deployed + `greet()==Hello NEXORA` live (earlier session). **Workbench §4.1-corrected AIdRegistry+AidFactory deployed+independently verified** on fresh loopback 902024 (`observations-2026-11-07-broadcast.json`, `verify_broadcast.py` PASS): Registry `0x3d641a2791533b4a0000345ea8d509d01e1ec301`, Factory `0x07aa076883658b7ed99d25b1e6685808372c8fe2`, CREATE2 `0xbd19e1d5c6391ad767b99282af241f8de4b5f508`, 4 txs receipt `0x1`, getters 902024/registered/verified true. **Canonical AID Registry still has SPEC §4.1 issue (C2) — not canonical merge/mainnet/audit.** |
| Parallel execution only with documented design + benchmark | N/A (no new parallel-execution engine) | — |
| Resolve critical/high findings | No such findings exist in this repo baseline (no audit) | `docs/STATUS.md`, `COMPREHENSIVE-REPORT.md` |

No invented criteria were added.

## 3. Toolchain — all user-local under `workbench/toolchain/`

| Tool | Provenance | sha256 / verification |
|---|---|---|
| Go 1.25.9 (windows/amd64) | official `https://go.dev/dl/go1.25.9.windows-amd64.zip` (exact pin from `ci/testnet/start-local-node.sh`, CI workflows) | `a7a710e2…e22cc`, `Get-FileHash` MATCH; `go version go1.25.9 windows/amd64` ✔ |
| Upstream `cosmos/evm` v0.7.3 | GitHub SHA-addressed archive `…/archive/c3ae9067a7eadcdea55a5192226916deb44c71c4.zip` (pin from ci config; WSL unusable, no git binary → archive used) | zip `ec8babab…a451`; content check: `go.mod` requires `go 1.25.9`, chain builds + runs with v0.7.3 semantics |
| C compiler: zig 0.17.1 x86_64-windows | official `https://ziglang.org/download/0.17.1/…zip`; SHA256 from `ziglang.org/download/index.json` (`shasum`) | `b03f477a…1562e`, MATCH via `Get-FileHash`; `zig version 0.17.1`; `zig.exe cc --version` → clang 22.1.8 ✔ |
| Foundry 1.8.5 windows | official `…/foundry/releases/download/v1.8.5/foundry_v1.8.5_win32_amd64.zip` (pin from `aid-tests.yml` / `testnet-epoch.yml`) | zip `21f86b56…8f5aa45` (no checksum file fetched — github.com transiently unreachable, twice curl exit 28); `forge --version` → 1.8.5, commit 51a52c59 ✔ |
| `evmd.exe` (built) | `go build -tags netgo -trimpath -o workbench/toolchain/bin/evmd.exe ./cmd/evmd` from `evmd/` subdir, `GOPATH/GOCACHE` under `workbench/toolchain/`, `CGO_ENABLED=1`, `CC=bin/zig-cc.cmd` | `90c2244a…26e`, 265,357,824 bytes; `evmd --help` OK; `evmd status` OK |

Exact build sequence (from audit/review):

```
cd workbench/toolchain/evm-c3ae9067…/evmd
CGO_ENABLED=1 CC=…/bin/zig-cc.cmd CXX=…/bin/zig-cxx.cmd go build -tags netgo -trimpath -o …/bin/evmd.exe ./cmd/evmd
```

Earlier failures, captured verbatim: `cgo: C compiler "gcc" not found`
(CGO=1, no CC) and `secp256k1.RecoverPubkey / VerifySignature undefined`
(CGO=0, no CGO fallback). The zig-clang wrapper fixed both without any
system-wide install.

## 4. Local testnet — isolated single-validator devnet

Path: `workbench/local-testnet/home` (own genesis, never reads `testnet/`).

- Genesis: `workbench/local-testnet/genesis_win.py` mirrors
  `ci/phase2/genesis.sh` without jq/bash: `chain/nexora-devnet.json`
  (`eip155:902024`, anex/18, `2026-01-01T00:00:00Z`) + mnemonics parsed at
  runtime from `local_node.sh` in the pinned upstream checkout. Determinism
  verified: two runs → byte-identical `genesis.json`
  (`sha256 d2a37920…789ac4`, differs from canonical `a04b29aa…` only by
  platform JSON serialization; stable across Windows runs).
- Node start mirrors `ci/phase2/verify.sh` single-node flags, loopback
  only: `--json-rpc.address 127.0.0.1:8545`.
- **Host quirk found + fixed:** this machine's DNS cannot resolve
  `localhost` (`"lookup localhost on 1.1.1.1:53: no such host"`). The
  canonical genesis binds `localhost` for pprof/api/grpc; those servers
  error → errgroup cancels ctx → JSON-RPC stops while CometBFT blocks
  continue (diagnosed from `node.log`; `network` field + blocks fine, RPC
  absent). Fix applied in `genesis_win.py` + existing home: bind
  `127.0.0.1` for pprof (`config.toml`), api/grpc (`app.toml`). Same
  parameters, loopback by IP instead of by name.

Live verification (this session, `observations-2026-11-07.json`):

| Check | Result |
|---|---|
| `eth_chainId` | `0xdc388` (902024) — matches `chain/nexora-devnet.json`; reference `0x40000` absent |
| `net_version` | `902024` |
| Blocks | advancing (0xd0→0xd3 in 3 s; log shows ~1/s; deploy at block 500) |
| `eth_getBalance(dev0)` | 1000 anex |
| `eth_estimateGas` (transfer) | `0x5dc0` (24000) |
| `eth_gasPrice` | `0x0` — base fee decayed to zero across idle empty blocks; canonical configured `2000000000anex` still clears base fee. Differs from `docs/STATUS.md` ~1.125 gwei, which was observed on a tx-active chain; gas price is height/activity-dependent |
| CometBFT `evmd status` | `eip155:902024`, caught up, height 182+ |
| Ports | `127.0.0.1:8545`, `8546`, `1317`, `9090`, `26657` only (netstat verified) |

Single-validator only: the 4-validator consensus story (Phase 3) remains
CI-VERIFIED, not locally re-run here.

## 5. Phase 5 contracts

### Local suites (Foundry, this host) — all pass

- `aid/` Solidity: **45/45** (`forge test`, exit 0)
- `contracts/` Solidity: **70/70** (`forge test`, exit 0)
- `aid/` JavaScript: **40/40** (`node --test`, exit 0) after `npm install`
  of the pinned `js-sha3@0.9.3`

### On local NEXORA devnet/testnet chains (loopback, disposable)

- **Done (earlier):** `NexoraGreeter` (`contracts/src/NexoraGreeter.sol`, constructor `"Hello NEXORA"`) deployed via `forge create --rpc-url http://127.0.0.1:8545` (script `workbench/local-testnet/deploy_greeter.mjs`; test-only key from public upstream mnemonic, never printed) → address `0x3D641a2791533B4A0000345eA8d509d01E1ec301`, receipt gasUsed 476045, `effectiveGasPrice 1`, block 500, `greet()` returns `"Hello NEXORA"`.
- **Done (Task 3, workbench-only, verified):** On a *fresh disposable* loopback chain 902024 (`workbench/aid-deploy/fresh-home-2026-11-07`, `eth_chainId` `0xdc388` verified twice pre-broadcast), safe `script/DeployAid.s.sol --broadcast` deployed **workbench §4.1-corrected** AIdRegistry `0x3d641a2791533b4a0000345ea8d509d01e1ec301` and AidFactory `0x07aa076883658b7ed99d25b1e6685808372c8fe2` (CREATE2 sample instance `0xbd19e1d5c6391ad767b99282af241f8de4b5f508`). Independent `verify_broadcast.py` **PASS**: all 4 txs receipt `0x1`, bytecode present, `configuredChainId=902024`, `totalRegistrations=1`, native registered/verified true, CREATE2 deployed/predicted true. Evidence: `workbench/aid-deploy/observations-2026-11-07-broadcast.json`. Listeners closed after stops.
- **Gap remains (C2):** Canonical `aid/src/AidRegistry.sol` still has SPEC §4.1 caller-supplied `chainId` issue; workbench on-chain proof is **not** canonical merge/spec closure/audit/mainnet readiness. No `unsafe-export`/re-broadcast. Foundry cache warning handled with schema-only inspection; deleted only `cache/.../run-latest.json` (321B); do not claim definitive private-key absence.

## 6. EVM/RPC compatibility + gas package

Path: `workbench/evm-compat/` (8/8 tests, exit 0).

- `src/matrix.mjs` — 12-row matrix. 10 rows `CI-VERIFIED` (canonical
  scripts + Phases 1–3 Actions), 2 `NOT-RUN` (`eth_estimateGas`, Phase 5
  contracts on chain) — both now **partially live-verified** in
  `observations-2026-11-07.json` (estimateGas 0x5dc0; Greeter only).
  The matrix source stays conservative: live facts live in observations,
  never as edits to canonical claims.
- `src/gas.mjs` — BigInt-only models pinned to `chain/nexora-devnet.json`
  (1 gwei floor / 2 gwei configured; live `effectiveGasPrice=1` confirms
  1anex-per-gas = 1 wei-per-gas semantics).
- `src/probe.mjs` + `scripts/probe.mjs` — loopback probe; verified
  disconnected-without-node + fake-upstream labeling in tests.
- `workbench/nexora-scan` untouched, re-run: **11/11** (exit 0). No
  Cloudflare/tunnel change; nothing published.

## 7. Test counts (this session, exact commands)

| Suite | Result |
|---|---|
| `cd market && node --test test/*.test.mjs` | 41/41, exit 0 |
| `cd workbench/phase6-integration && node --test test/*.test.mjs` | 85/85, exit 0 |
| `cd workbench/evm-compat && node --test test/*.test.mjs` | 8/8, exit 0 |
| `cd workbench/nexora-scan && node --test test/*.test.mjs` | 11/11, exit 0 |
| `cd aid && node --test test/*.test.mjs` | 40/40, exit 0 |
| `cd aid && forge test` | 45/45, exit 0 |
| `cd contracts && forge test` | 70/70, exit 0 |

Baselines unchanged. New failures: none (one self-review fix inside the
new evm-compat test: `0x430e2340` = 1,125,000,000 wei, not 1,126,084,224).

## 8. Remaining blockers / next steps

- Wallet/contract path: deploy `AIdRegistry` + `AidFactory` (+ any
  dependents) on the local devnet, same pattern as `deploy_greeter.mjs`.
- 4-validator local consensus drill (Phase 3 rerun on Windows impedes:
  canonical multi-home scripts are bash + distinct 127.0.0.x setup; needs
  a Windows port or Linux access).
- Market models, migration, benchmarks: parallel session's scope.
- Foundry checksum re-verification when github.com is reachable again.
- Git: no `git` binary on host PATH; HEAD/status verified via `.git/HEAD`
  (`863cd4dd… end-to-end (…4501873bf)`, branch `main`) + file inspection.
  All work is untracked under `workbench/`; nothing committed, nothing
  pushed. Tracked-tree files (market/, ci/, docs/, chain/, contracts/,
  aid/) were only read or executed (forge outputs go to `out/`/`cache/`
  build artifacts inside those projects — verify with a future `git
  status` when git is available).
- Node stopped at session end; restart with the same `evmd start` flags.

## 9. Appendix — provenance hashes (2026-11-07)

- Go archive: `a7a710e225467b34e9e09fb432b829c86c9b2da5821ee5418f7eb2e8ae1a22cc`
- evmd.exe: `90c2244aaed95e0fde8fae0abfeeb93ff2bcb7e5fa288f4fa7bbcb641a94226e`
- Zig archive: `b03f477a1943673e02aca0f570e8030dffd536ce1f45cbc4d3326ec31159562e`
- Foundry archive: `21f86b563d87404a68481f513bf3e419780ee536307b89c658215ae6f8f5aa45`
- Local genesis: `d2a379207d2d27ffaea9a8f6a33866fc9fa9401cf41bca427bf65aef6c789ac4`

## 10. Final honest status

- DONE: user-local Go + Zig/Clang toolchain, pinned `cosmos/evm v0.7.3`
  `evmd.exe` build, deterministic isolated genesis, live single-validator
  local testnet with `eth_chainId=0xdc388`, advancing blocks, balance/gas
  probes, and `NexoraGreeter` live deploy + call.
- DONE IN WORKBENCH: ICMA/curve integration, credit/FX/crypto models,
  Market Simulation reconstruction, model-state migration, benchmarks,
  EVM/RPC compatibility model, read-only NEXORA Scan; all current suites
  pass as recorded in §7 and Addendum §11.
- PARTIAL: AID Registry/Factory path. Canonical Registry has a SPEC §4.1
  chain-id trust defect; a corrected workbench-only copy builds and passes
  19 dedicated tests (48 total including vectors/Factory), but **no AID
  contract transaction was broadcast**. The local Foundry script simulation
  succeeded but was pre-broadcast only.
- BLOCKED / OUTSTANDING: AID on-chain deployment; local four-validator
  consensus drill; canonical `market/` integration/review/merge; AID SPEC
  draft closure and independent Solidity/JS vector cross-check. No security
  audit claimed.
- No tracked source edits, commit, push, merge, public RPC, Cloudflare,
  DNS, tunnel, or publish action. The test node is stopped; relevant ports
  have no LISTENING sockets.

## 11. Addendum — AID Registry/Factory review (2026-11-07)

### Critical contract/spec mismatch

Review of canonical `aid/src/AidRegistry.sol` found that its `register`
and `verify` methods accept caller-supplied `chainId`. `aid/SPEC.md`
§4.1 requires a contract to derive the chain domain from `block.chainid`
and reject a mismatch against its configured chain constant. This is a
real contract/spec mismatch; the canonical files were not edited and the
canonical Registry was not deployed.

A corrected copy exists only in `workbench/aid-deploy/src/AidRegistry.sol`:
it removes caller-supplied chain ID parameters, reads `block.chainid`,
requires chain ID 902024, and reverts with `AidChainMismatch` for
wrong-chain/fork calls. The copied `AidFactory.sol` is byte-for-byte
identical to the canonical Factory. Workbench `Aid.sol` contains the
workbench-only mismatch error needed by the Registry consumer.

### Build and test evidence

- `forge build` in `workbench/aid-deploy`: exit 0 (warnings only).
- `forge test` in `workbench/aid-deploy`: 48 passed, 0 failed,
  0 skipped (AidVector 16, AidFactory 13, AidRegistryCorrected 19), exit 0.
- A Foundry deployment script was created under
  `workbench/aid-deploy/script/DeployAid.s.sol`. It asserts chain ID
  902024, deploys the corrected Registry and unchanged Factory, registers
  the native AID identifier, and exercises a deterministic CREATE2 sample.
- A pre-broadcast simulation ran successfully using the test-only `dev0`
  key supplied to the Foundry process through an environment variable,
  then cleared in a `finally` block. It did not pass a key on the command
  line or write a key to disk. The successful log says
  `Script ran successfully. SIMULATION COMPLETE.`, chain 902024,
  estimated gas 1,484,031.
- **No `--broadcast` was used. No on-chain transaction was sent. No AID
  Registry/Factory address or transaction hash exists.** Deployment remains
  not executed; do not interpret the simulation-created script runner
  address as a deployed Registry/Factory.
- `workbench/aid-deploy/deploy-aid.mjs` is marked
  `UNSAFE DRAFT — DO NOT RUN` because it passes a key in CLI arguments.
  It was not executed and must not be used.

### Final verification matrix — 2026-11-07

All commands were run from their respective workbench/project directories.
The final PowerShell parallel test runner completed every process with
exit code 0; exact output is saved under `workbench/aid-deploy/test-results/`.

| Suite | Passed | Failed | Exit |
|---|---:|---:|---:|
| Workbench AID corrected Solidity | 48 | 0 | 0 |
| Canonical AID Solidity | 45 | 0 | 0 |
| Canonical AID JavaScript | 40 | 0 | 0 |
| Main contracts Solidity | 70 | 0 | 0 |
| Market baseline | 41 | 0 | 0 |
| Phase 6 ICMA/curve integration | 85 | 0 | 0 |
| Phase 6 credit/FX/crypto/simulation/migration | 20 | 0 | 0 |
| EVM/RPC compatibility | 8 | 0 | 0 |
| NEXORA Scan | 11 | 0 | 0 |
| **Total** | **368** | **0** | **0** |

### Local node shutdown / Git state

The local testnet process (PID 2688) was stopped. A final
`Get-NetTCPConnection -State Listen` check on ports 8545, 8546, 26657,
26656, 1317, 9090, 3100, 6060 and 8100 returned no listeners; remaining
client-side `TIME_WAIT` entries are not listeners. No `evmd` process
remained.

Git metadata check: `.git/HEAD` is `ref: refs/heads/main`; the main
ref remains `863cd4ddc06a61375ccc56d30ed9a8f4501873bf`. No commit,
push, or merge was made. Git executable was not available in the current
OpenCode shell, so this is an object/ref check rather than a freshly
executed `git status`.

The AID SPEC is still DRAFT; independent Solidity cross-check of all
vectors and §10 decisions remain open. The Market Simulation is a
reconstruction, not a recovered historical implementation. Phase 6
overall therefore remains **IN PROGRESS**, not complete.


---

## 12. Detailed AID on-chain path — continuation (workbench only)

Scope: complete the AID on-chain path from the completed local EVM testnet work. No tracked source modified, no commit/push/merge/publish, no Cloudflare/DNS, no public RPC. All listeners loopback-only. Git state unchanged: `.git/HEAD` = `refs/heads/main`, ref `863cd4ddc06a61375ccc56d30ed9a8f4501873bf`.

### Critical finding (SPEC §4.1) — canonical Registry NOT deployed
`aid/src/AidRegistry.sol` (canonical, tracked, sha256 `e8dbe577c8704927ad429d3cb5d24f15c13fc8026ce195d64c189f4c40755ec4`) accepts caller-supplied `uint256 chainId` in `register`/`verify`. `aid/SPEC.md` §4.1 requires contracts to read `block.chainid` and verify against a configured constant. **Canonical Registry was not deployed.** A workbench-only corrected copy was created at `workbench/aid-deploy/src/AidRegistry.sol` (sha256 `ab40a031bab22177001567527354c89f209b7c742ca2cedc69d60c68a91800df`): no chainId args, `block.chainid` checked against configured `902024`, `Aid.AidChainMismatch` on mismatch/fork, `configuredChainId()` getter. `AidFactory` unchanged (hash `8a9c9d8c63d44d6a29a6ad7609879f982dbb9e35fa8c95848f27bc537976846f`, identical to canonical). Workbench `Aid.sol` adds only `error AidChainMismatch(uint256,uint256)` for the corrected consumer. Details: `workbench/aid-deploy/README.md`, `REGISTRY-DIFF-SUMMARY.md`, `observations-2026-11-07.json`.

### Build/tests (workbench artifact)
`workbench/aid-deploy` Foundry build + tests: **48 passed, 0 failed, 0 skipped** (AidVector 16, AidFactory 13, AidRegistryCorrected 19), exit 0. Corrected tests cover `configuredChainId()==902024`, no-chainId register/verify API, metadata/type rejection, first-claim-wins, retraction, pagination, `vm.chainId(1)`/fork mismatch reverts, and caller-spoof regression.

### Local testnet validation (no AID broadcast)
Existing `workbench/local-testnet/home` preserved (genesis_win.py **not** rerun; it deletes home). Config hardening (workbench home only): P2P `tcp://127.0.0.1:26656`, Prometheus `127.0.0.1:26660`. `evmd` restarted (PID 2688) with prior single-validator flags (`--home` existing workbench home, `--chain-id eip155:902024`, `--minimum-gas-prices 1anex`, `--evm.evm-chain-id 902024`, `--evm.min-tip 0`, `--pruning nothing`, `--log_level info`, `--json-rpc.enable true`, `--json-rpc.address 127.0.0.1:8545`, `--json-rpc.api eth,txpool,personal,net,debug,web3`). Verified: `eth_chainId=0xdc388`, `net_version=902024`, height advanced `0x27c -> 0x27e` over 3s. Listeners loopback-only (127.0.0.1 for 26657,26656,9090,8546,8545,8100,6060,1317). Node stopped at end; no LISTENING on 8545/8546/26657/26656/1317/9090/3100/6060/8100 (transient TIME_WAIT only).

### Initial deployment status (before later authorized Task 3 broadcast)
**No AID contracts deployed. No transactions sent. No addresses/txs created.** A safe Foundry script `script/DeployAid.s.sol` was built (asserts chain 902024; reads `DEPLOYER_PRIVATE_KEY` via `vm.envUint`; no `--private-key` CLI arg; deploys corrected Registry + Factory; native register/verify; CREATE2 sample with specified initCode/assetId `0x1111`). A **real-key local simulation only** (dev0 test key from existing keyring-test in process env, 0x-prefixed, cleared in `finally`; never printed/written/filed/CLI; `--broadcast` NOT used) succeeded: **`Script ran successfully. SIMULATION COMPLETE.`**, chain 902024, estimated total gas **1,484,031** (`workbench/aid-deploy/forge-script-sim.log`). Deployment was deliberately left at pre-broadcast simulation under the operator safety instruction; no broadcast command was run and no on-chain transaction was sent. `deploy-aid.mjs` is **UNSAFE DRAFT / NEVER RUN** (passed key via CLI args) and was marked as such.

### Final regression suites (all exit 0, 368 passed / 0 failed)
| Suite | Result |
|---|---:|
| workbench/aid-deploy `forge test` | 48/48 |
| aid `forge test` | 45/45 |
| aid `node --test test/*.test.mjs` | 40/40 |
| contracts `forge test` | 70/70 |
| market `node --test test/*.test.mjs` | 41/41 |
| workbench/phase6-integration `node --test` | 85/85 (preserved) |
| workbench/phase6-market-models `node --test` | 20/20 |
| workbench/evm-compat `node --test` | 8/8 |
| workbench/nexora-scan `node --test` | 11/11 |

### Earlier-pass status (superseded by Task 3 addendum below)
- **DONE (this continuation):** SPEC §4.1 Registry issue identified; corrected workbench artifact built/tested (48/48); safe Foundry deployment script built; local testnet restarted/validated/stopped; successful real-key no-broadcast simulation documented; all final suites green (368/0).
- **NOT DONE / BLOCKED:** AIdRegistry + AidFactory not deployed on local testnet (broadcast blocked). Canonical Registry has unresolved SPEC §4.1 implementation issue and must not be deployed as-is.
- **Still outstanding (Phase 6):** 4-validator local consensus drill (CI-only); canonical market merge/review. Market Simulation is a reconstruction, not historical recovered code. `aid/SPEC.md` remains **DRAFT** (independent Solidity cross-check of all vectors and §10 decisions open). **No security audit claimed.**


## 13. Continuation addendum (2026-11-07, Task 1/3/audit/docs)

- **Task 1 VERIFIED (fresh):** `workbench/local-testnet/verify-2026-11-07/task1-evidence.json` — genesis determinism `49382862…` (2 runs), `eth_chainId=0xdc388`, `net_version=902024`, block `0x1→0x2`, `gasPrice=0x3aac5ed8`, `baseFeePerGas=0x2da282a8`, `estimateGas=0x5dc0`, balance 1000 anex, PID-scoped stop, no 8545 listener. Readiness waits for valid `eth_blockNumber` (pre-block-1 transient). Hash differs from CI `a04b29aa…` (platform serialization) — deterministic locally, not cross-platform byte identity.
- **Chain-ID conflict (C1, requires decision):** `ROADMAP.md` says Cosmos `nexora-devnet-1` but `chain/nexora-devnet.json` + CI genesis scripts + reports use `eip155:902024` (EVM `902024/0xdc388`). No canonical config edited. See `workbench/PHASE1-5-READINESS-AUDIT.md`.
- **Phase 5 / SPEC §4.1 (C2):** canonical `aid/src/AidRegistry.sol` accepts caller-supplied `chainId` contrary to `aid/SPEC.md` §4.1; test pass ≠ spec closure/on-chain readiness. Workbench corrected artifact tested (48/48) but canonical source unmerged.
- **Phase 3 local (C3):** 4-validator CI-passed only; WSL blocked on this host.
- **Task 3 AID broadcast (AUTHORIZED, loopback-only, verified):** fresh home `workbench/aid-deploy/fresh-home-2026-11-07`, chain `0xdc388` checked twice pre-broadcast, safe `script/DeployAid.s.sol --broadcast` with env-only `DEPLOYER_PRIVATE_KEY` (not CLI/printed/intentionally written). **Verified PASS** (`verify_broadcast.py`): Registry `0x3d641a2791533b4a0000345ea8d509d01e1ec301`, Factory `0x07aa076883658b7ed99d25b1e6685808372c8fe2`, CREATE2 `0xbd19e1d5c6391ad767b99282af241f8de4b5f508`; all 4 txs receipt `0x1`; `configuredChainId=902024`, `totalRegistrations=1`, native registered/verified, CREATE2 deployed/predicted match. Evidence: `workbench/aid-deploy/observations-2026-11-07-broadcast.json`. Unsafe `deploy-aid.mjs` never executed.
- **Foundry cache security:** Forge warned “Sensitive values saved” to cache `run-latest.json`. Schema-only inspection found no sensitive-key-named fields (`transactions[].rpc` + hex64-like `recovery_generation` only; value not printed). Deleted only `cache/.../902024/run-latest.json`; broadcast/evidence preserved. **Do not claim key was never written to disk** (warning + cache existed; schema-only proof insufficient). No re-export/re-broadcast.
- **IDs used consistently:** Cosmos `eip155:902024`, EVM `902024`/`0xdc388` (actual config/genesis).
