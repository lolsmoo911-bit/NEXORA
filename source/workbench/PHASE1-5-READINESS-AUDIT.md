# NEXORA — Phase 1–5 readiness audit (evidence-based)

Date: 2026-11-07 (Africa/Algiers). Auditor: OpenCode session (workbench).  
Repo: `C:\Users\Administrator\NEXORA-ANEX-REBUILT\source` @ `863cd4ddc06a61375ccc56d30ed9a8f4501873bf` (`main`), no local git binary; all work isolated under `workbench/`.

**Rule applied:** unit/CI test pass ≠ deploy/production readiness. Each criterion is mapped to command/test/evidence, status, and gap.

## Sources (read)

`ROADMAP.md`; `docs/phase0-report.md`–`phase5-report.md`; `docs/STATUS.md`; `docs/COMPREHENSIVE-REPORT.md`; `docs/phase2-chain-ids.md`; CI scripts under `ci/`; chain config `chain/nexora-devnet.json`; workbench evidence (evm-compat, local-testnet, aid-deploy, phase6-integration, phase6-market-models).

## Critical inconsistencies / decisions required (do not silently reconcile)

| ID | Inconsistency | Evidence (source of truth candidates) | Impact | Required decision |
|---|---|---|---|---|
| C1 | **Cosmos chain ID naming conflict** | `ROADMAP.md` Phase 2 states Cosmos chain id `nexora-devnet-1`; but `chain/nexora-devnet.json` has `cosmos_chain_id:"eip155:902024"` (single source read by `ci/phase2/genesis.sh` and `ci/phase3/gen4-genesis.sh`), `docs/phase2-report.md`/`phase2-chain-ids.md`/`docs/STATUS.md` state `eip155:902024`, and `evmd start`/genesis use `eip155:902024`. EVM chain ID is consistently 902024/0xdc388. | ROADMAP contradicts implemented/configured/CI reality; downstream docs/scripts/wallets could be misconfigured if ROADMAP is followed literally. | Decide canonical Cosmos chain-id string: keep `eip155:902024` (matches config+CI+reports) and correct ROADMAP, or migrate config/genesis/CI/scripts/docs to `nexora-devnet-1` (state-breaking/regenerative). **No canonical config edited in this session.** |
| C2 | **Phase 5 “complete” vs SPEC §4.1 implementation gap** | `ROADMAP.md` marks Phase 5 complete with CI #38247229940; but canonical `aid/src/AidRegistry.sol` accepts caller-supplied `chainId` while `aid/SPEC.md` §4.1 requires contracts to read `block.chainid` and verify against a configured constant (fail loudly on mismatch). Workbench corrected copy exists (`workbench/aid-deploy/src/AidRegistry.sol`) with 19 targeted tests and was **broadcast+independently verified on a disposable local loopback chain 902024 (2026-11-07)**; canonical tracked source unchanged. | Unit/Foundry test pass on canonical implementation **does not equal** spec closure or safe on-chain readiness for that §4.1 requirement. Workbench on-chain proof is valid only for the corrected workbench artifact on a disposable testnet — not canonical merge/audit/production. | Review/accept §4.1 correction path, add/merge canonical fix + tests, re-run CI, and treat as spec-closure/remediation item before any audited/mainnet-facing claim. |
| C3 | **Phase 3 CI passed but 4-validator not locally re-verified** | Actions #38179431126 success; this host cannot run WSL (`WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`) and multi-home bash flow is non-trivial on Windows. | Local confidence for multi-validator fault/recovery is limited to CI evidence. | Reproduce in Linux/CI, or produce a Windows-safe isolated 4-home drill/CI job with evidence. |

**ID reporting convention (this audit):** Cosmos chain ID = `eip155:902024` (actual config/genesis/scripts/reports). EVM chain ID = `902024` / `0xdc388`. The `nexora-devnet-1` string appears only as the ROADMAP conflict noted above.

## Phase 0 — Reconnaissance (ROADMAP: CLOSED)

| Acceptance criterion | Evidence | Status | Gap |
|---|---|---|---|
| Baseline chosen with evidence | `docs/phase0-report.md`, `docs/architecture-decision-record.md`, `chain/upstream.md` (per ROADMAP) | **Documented/CLOSED per ROADMAP** | Not re-verified by this session against original artifacts beyond presence in docs tree; ADR content not exhaustively re-audited here. |
| Limitations reported honestly; no build claimed that was not performed | Phase 0 report states constraints | **Documented** | Historical claim; no independent reproduction needed for recon phase. |

## Phase 1 — Unmodified reference chain (ROADMAP: COMPLETED 2026-10-10)

| Acceptance criterion | Evidence (canonical) | Local re-verification (2026-11-07) | Status | Gap |
|---|---|---|---|---|
| Reproducible build from clean checkout on CI | Actions #38016004413, `515d070`; `docs/phase1-report.md` | evmd built locally from pinned `cosmos/evm c3ae9067` with Go 1.25.9 + zig CGO (`workbench/toolchain/bin/evmd.exe`, sha `90c2244a…`) — **different host/toolchain path (Windows+zig) than CI (Linux)** | **CI-VERIFIED; local build reproduced on Windows (non-canonical path)** | Not a clean Linux CI rerun in this session. Windows CGO path is a workaround, not canonical CI parity. |
| Node produces blocks | CI transcript | Fresh verify home: `eth_blockNumber` 0x2→0x6 (advancing), `workbench/local-testnet/verify-2026-11-07/task1-evidence.json` (pass) | **LOCAL PASS (single-validator, fresh isolated home)** | Single validator only; 4-validator consensus not locally re-run. |
| JSON-RPC answers correct | CI: eth_chainId 0x40000 (262144) reference | NEXORA devnet config verified on fresh node: `eth_chainId=0xdc388`, `net_version=902024`, `web3_clientVersion` present, `eth_gasPrice`/baseFee observed, block shape keys present | **LOCAL PASS for NEXORA 902024** | `eth_getLogs`/filters, tx pool, subscriptions not exhaustively exercised. `eth_gasPrice` 0x0 on idle chain (base fee decay) — differs from historical tx-active observation; documented. |
| Contract deploys and callable | CI: NexoraGreeter "Hello NEXORA" | Prior session: NexoraGreeter deployed/called on local 902024 (evm-compat observations). This session: task1 probe focused on RPC; Greeter not redeployed on verify home. | **LOCAL PASS (prior session evidence) + CI-VERIFIED** | Not re-executed in this exact verify run; reproducible via existing script. |
| Transcripts recorded | artifact `phase1-transcripts` | — | **CI artifact claim (not re-fetched)** | Artifact not downloaded/verified in-session. |

## Phase 2 — NEXORA chain configuration (ROADMAP: COMPLETED 2026-10-10)

| Acceptance criterion | Evidence (canonical) | Local re-verification | Status | Gap |
|---|---|---|---|---|
| Deterministic genesis (two runs byte-identical SHA256) | Actions #38071169448; `a04b29aa…` on CI/Linux | **Fresh Windows runs (this session):** `49382862…0393abc1` identical across `verify-2026-11-07/home1,home2` (`task1-evidence.json`). Differs from CI hash due to platform JSON serialization / home derivation details; **deterministic on this platform**. | **LOCAL PASS (determinism proven, hash differs from CI artifact)** | Cross-platform byte identity vs CI `a04b29aa…` not proven; must not claim CI hash reproduced. |
| Documented parameters (both chain IDs, denom decimals, fees) | `chain/nexora-devnet.json`, `docs/phase2-chain-ids.md` | Config verified: eip155:902024 / 0xdc388, anex 18 (nex), min_gas 1anex, gas 2gwei; live chainId/net_version matched. | **PASS** | — |
| Transfers and Solidity deploy succeed | CI (Cosmos+EVM legs) | RPC/chain ready; Greeter deploy evidenced prior; AID broadcast attempted separately (task 3). | **PARTIAL LOCAL (EVM RPC + prior Greeter)** | Full Cosmos bank transfer leg not re-run locally in this session. |
| No consensus code changes; rollback documented | Config-only claim in report | Not re-audited at source-diff level beyond using pinned upstream binary/build | **Documented/CI-VERIFIED** | No `git diff` vs upstream in-session (no git binary). |
| validate-genesis passes | CI | `verify_task1.py` runs `evmd genesis validate-genesis` (exit checked in gen_home) | **LOCAL PASS** | — |
| Known limitation: bech32 `cosmos`, ephemeral CI | report | unchanged | **OPEN (accepted limitation)** | — |

## Phase 3 — Multi-validator devnet + recovery (ROADMAP: COMPLETED 2026-10-12)

| Acceptance criterion | Evidence (canonical) | Local re-verification | Status | Gap |
|---|---|---|---|---|
| 4 nodes reach consensus, agree height/app_hash | Actions #38179431126, `dc2df78`; `docs/phase3-report.md` | **Not run locally** (Windows/LocalSystem, bash multi-home scripts, WSL blocked `WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`) | **CI-VERIFIED ONLY** | Local 4-validator drill blocked by host constraints; CI reproduction plan needed (Task 5). |
| Kill one does not halt chain | CI | Not run locally | **CI-VERIFIED ONLY** | — |
| Restart re-syncs | CI | Not run locally | **CI-VERIFIED ONLY** | — |
| Recovery procedure documented and tested | `ci/phase3/run-4validators.sh` etc. | Scripts present; not executed on this host | **CI-VERIFIED / scripts present** | — |
| Deterministic genesis (multi-node) | CI | Single-node determinism proven locally | **PARTIAL** | Multi-node genesis determinism not locally reproduced. |

## Phase 4 — AID specification & implementation (ROADMAP: COMPLETED 2026-10-12)

| Acceptance criterion | Evidence (canonical) | Local re-verification | Status | Gap |
|---|---|---|---|---|
| `aid/SPEC.md`, canonical encoding, vectors, reference libs, Solidity libs, tests/fuzz, deterministic assetId | Actions #38245177000; `docs/phase4-report.md` | **This session re-ran:** `aid/` JS 40/40, `aid/` Forge 45/45 (exit 0). Workbench corrected registry tests 48/48 in `aid-deploy`. | **LOCAL PASS (test suites) + CI-VERIFIED** | SPEC remains DRAFT (per spec/docs); independent Solidity cross-check of all vectors / §10 decisions open per prior audit. **SPEC §4.1 chainId trust issue found in canonical Registry** — corrected only in workbench artifact; canonical tracked source unfixed. Not deploy/production readiness. |
| Keccak-256 proven (not SHA3-256) | vectors/tests | covered by passing suites | **PASS (within suite scope)** | — |

## Phase 5 — AID registry & deterministic CREATE2 deployment (ROADMAP: COMPLETED 2026-10-12)

| Acceptance criterion | Evidence (canonical) | Local re-verification | Status | Gap |
|---|---|---|---|---|
| Registry, CREATE2 factory, vanity search, honest estimates | Actions #38247229940; `docs/phase5-report.md` | Canonical suites pass (AID Forge 45/45, JS 40/40; contracts 70/70). **On-chain (disposable local loopback 902024, 2026-11-07, workbench §4.1-corrected artifacts only):** `workbench/aid-deploy/observations-2026-11-07-broadcast.json` + `verify_broadcast.py` PASS. Registry `0x3d641a2791533b4a0000345ea8d509d01e1ec301` (tx `0xbfb183…9e8e`, 0x1), Factory `0x07aa076883658b7ed99d25b1e6685808372c8fe2` (tx `0x46f878…79ef`, 0x1), register tx `0x7eace5…0bdf` (0x1, 1 log), CREATE2 deploy tx `0x8e1016…6717` (0x1, 1 log), instance `0xbd19e1d5c6391ad767b99282af241f8de4b5f508`; `configuredChainId=902024`, `totalRegistrations=1`, native registered/verified true, CREATE2 deployed/predicted true. Listeners closed post-stop. | **CI-VERIFIED (canonical suites). LOCAL ON-CHAIN VERIFIED (workbench-corrected artifacts, disposable loopback only). Canonical SPEC §4.1 closure / merge NOT complete.** | `docs/phase5-report.md` §7 note addressed only for workbench-corrected artifacts on disposable local testnet — **not** canonical merge/mainnet/audit. Vanity tool not re-run in this session. C2 remains open for canonical source. |

## Cross-cutting readiness gaps (honest)

- **Deploy/production ≠ test pass:** all green suites are necessary but insufficient. No audit, no production keys, testnet only, WSL/4-validator local gap, SPEC DRAFT, canonical §4.1 fix not merged.
- **Provenance:** local Windows evmd uses zig CGO workaround; Foundry zip hash recorded but checksum file not fetched (transient network) — binary identity verified by `forge --version` 1.8.5 / 51a52c59.
- **Key/cache handling:** no key values were printed in reports. The authorized testnet broadcast used a local test identity; Foundry emitted a “Sensitive values saved” cache warning. Schema-only inspection found no explicitly key-named fields, and the main `cache/.../run-latest.json` record was deleted, but the inspection cannot prove that no secret material was ever encoded in any opaque field. See `workbench/aid-deploy/README.md`; do not claim zero disk persistence.
- **Canonical changes:** none. All fixes/audits in `workbench/`.
