# Phase 0 Report — NEXORA Network (rev. 2)

Date: 2026-10-10
Status: Phase 0 deliverables complete (rev 2); **documentation phase formally
CLOSED by the owner on 2026-10-10** (six decisions adopted — see
`docs/architecture-decision-record.md`). Build **BLOCKED**: the executing
environment has no shell/toolchain, and no installs are permitted there.
Phase 1 will not start until a Linux environment verified against
`docs/phase1-environment.md` is available **and** the owner gives explicit
approval.

Legend: `V` verified, `A` assumption, `U` unverified. Sources are given
inline next to claims.

---

## 1. Environment inspection (execution environment for this phase)

| Item | Finding | Evidence |
|---|---|---|
| OS | **Debian 13 (trixie) Distroless** container | `/etc/os-release` (`V`) |
| Shell | **Unavailable** | `/bin` and `/usr/bin` list 0 entries; attempts to run `/bin/sh -c …` fail `NotFound` (`V`) |
| Git / Go / Docker / Node / jq / make / gcc / Foundry | **Absent** | empty `/usr/bin`, `/bin` (`V`) |
| Only runtime present | **Bun** (`/usr/local/bin/bun`, `bunx`) + `nodebun` | directory listing (`V`) |
| Filesystem tools | read / write / edit / glob work; grep/ripgrep unavailable | observed (`V`) |
| Network | GitHub API, `raw.githubusercontent.com`, `proxy.golang.org`, `docs.cosmos.network`, `cosmos.network` reachable | observed (`V`) |
| Package manager | **None** | — |

**Availability of a real execution environment (owner question #6):**
**No.** This sandbox is a distroless container with no shell, no package
manager, and no toolchain, and it cannot provide git/Go 1.25.9/make/Docker.
Per the owner's instruction, **nothing will be installed here**. Execution
must instead happen on an external Debian/Ubuntu host or container that the
owner provisions (or the owner runs the Phase 1 commands and returns the
transcripts for review/documentation). Until then, **no build or test success
is claimed** (`U` for all build behavior).

## 2. Repository and version selection — with evidence and sources

Per the owner's instruction, `https://github.com/cosmos/evm` was inspected
first (source: https://github.com/cosmos/evm) and compared against the
alternatives (see `docs/architecture-decision-record.md`).

**Selected: `github.com/cosmos/evm` — release `v0.7.3` — commit
`c3ae9067a7eadcdea55a5192226916deb44c71c4`** (Apache-2.0).

Why (all `V`):
- License **Apache-2.0** — https://github.com/cosmos/evm/blob/main/LICENSE
- Average version per the official Go module proxy (v0.7.3, 2026-09-03) —
  https://proxy.golang.org/github.com/cosmos/evm/@latest
- Modern stack pinned in v0.7.3 `go.mod` — Go 1.25.9, Cosmos SDK v0.54.3,
  CometBFT v0.39.3, ibc-go v11, Cosmos geth fork v1.17.2-cosmos-0 —
  https://github.com/cosmos/evm/blob/v0.7.3/go.mod
- Tagged releases; Docker-compose **4-node** localnet
  (`docker-compose.yml`, `evmdnode0..3`); JSON-RPC
  `eth,txpool,personal,net,debug,web3` (`local_node.sh`); Foundry + Hardhat
  test harnesses.
- Production usage claims published upstream: "used by Ondo, Mezo, Mantra, XRP
  sidechain, TAC, Stable" — https://github.com/cosmos/evm#readme
  (`V` as an upstream claim; `A` for each deployment's details).

Rejected with evidence: `evmos/os` (stale, no tags/releases,
https://github.com/evmos/os), `evmos/evmos` (non-commercial license,
https://github.com/evmos/evmos/blob/main/LICENSE), `evmos/ethermint` and
`ava-labs/subnet-evm` (archived:
https://github.com/evmos/ethermint,
https://github.com/ava-labs/subnet-evm). Custom consensus: forbidden by the
brief.

### 2.1 Release-family discrepancy (owner question #1) — documented, no deps changed

The owner's observation is **confirmed**: the canonical release-family guide
lists Cosmos SDK **0.55.x** and CometBFT **0.40.x** for Cosmos EVM **0.7.x**,
while the pinned v0.7.3 pins SDK **v0.54.3** / CometBFT **v0.39.3**.

Verified sources:
1. Release Families page (canonical): family **2026.1** = SDK 0.55.x /
   CometBFT 0.40.x / Cosmos EVM 0.7.x / IBC v11.x.y; family **2025.1** =
   SDK 0.53.x / CometBFT 0.38.x / Cosmos EVM 0.6.x / IBC v10.x.y; policy:
   "A component version is supported only when it appears in an active
   release family."
   https://docs.cosmos.network/sdk/latest/release-family
2. Official 2026.1 announcement blog: "CometBFT v0.39 … Cosmos SDK v0.54 …
   Cosmos EVM v0.7.0".
   https://cosmos.network/blog/cosmos-ledger-20261
3. SDK v0.55 upgrade guide: SDK v0.55 requires CometBFT v0.40.0; v0.54.x line
   shipped with CometBFT v0.39.x, ending at v0.39.3 in v0.54.3.
   https://docs.cosmos.network/sdk/latest/upgrade/v0.55
4. `main` and `release/v0.7.x` `go.mod` still pin SDK v0.54.3 / CometBFT
   v0.39.3 (checked directly) — **no `cosmos/evm` tag pins the 0.55/0.40
   combination yet**.
5. `docs/migrations/v0.7.x_to_v0.8.0.md` exists on `main` → v0.8.0 is in
   preparation (candidate aligned artifact).
   https://github.com/cosmos/evm/blob/main/docs/migrations/v0.7.x_to_v0.8.0.md

Interpretation (`A`): family 2026.1 was announced on SDK 0.54/CometBFT 0.39 and
the family page was later rolled forward to 0.55/0.40 (the page says supported
versions "are updated over time"). The family-aligned `cosmos/evm` tag is
**pending**; under a strict reading, SDK v0.54.3/CometBFT v0.39.3 are not in
the currently listed active family, while Cosmos EVM 0.7.x **is**. No
dependency was changed.

### 2.2 Audit scope (owner question #2) — correction

The audit **is not** an audit of v0.7.3:
- Report: `docs/audits/sherlock_2025_07_28_final.pdf` (present in the v0.7.3
  tree; listed on the official security-audits page,
  https://docs.cosmos.network/sdk/latest/security/audits).
- Dated **2025-07-28**; added to the repo 2025-07-28 (commits #365/#366);
  contemporaneous release **v0.3.0** (tagged 2025-07-25 from branch
  `audit/all`).
- Therefore it covers the **July-2025 codebase state (≈v0.3.x era)**, ~14
  months before v0.7.3. It happens to ship inside later tags.
- Exact audited commit: **`U`** (printed in the PDF; must be read in a tooled
  environment before any scoped claim).

### 2.3 Decimal handling (owner question #3) — correction

- Upstream README: "Cosmos EVM supports 18-decimal EVM gas-token chains.
  Non-18-decimal configurations are not supported."
  https://github.com/cosmos/evm#readme (`V`)
- Token decimals are chain configuration (`EvmCoinInfo.Decimals`). A module
  named `x/precisebank` (later `contrib/x/precisebank`) used to bridge a
  6-decimal native token to 18 decimals; it was **removed** from `cosmos/evm`
  (PR #1019, merged 2026-03-02, https://github.com/cosmos/evm/pull/1019) and is
  **not present in v0.7.3** (`x/` = `erc20`, `feemarket`, `ibc`, `vm` only).
- The v0.8.0 migration removes the module completely and standardizes on
  18-decimal (`EvmCoinInfo.Decimals = 18`).
  https://github.com/cosmos/evm/blob/main/docs/migrations/v0.7.x_to_v0.8.0.md
- The public docs page for PreciseBank is **stale** relative to the code:
  https://docs.cosmos.network/evm/latest/documentation/cosmos-sdk/modules/precisebank
- **Consequence:** NEXORA must adopt an **18-decimal base denom** (e.g. `anex`,
  1 NEX = 10^18 `anex`); PreciseBank is neither needed nor available for
  v0.7.3. A non-18-decimal denom must not be planned for.

## 3. Commands actually executed and their outcomes

### Shell commands — **not run** (not "failed tests")

No shell command executed with a toolchain result, because the environment has
**no shell at all**. The `NotFound` messages below are **environment-level
spawn failures** — the process never started — and are **not** build/test
failures. They are recorded here for completeness:

- `pwd` → `NotFound: ChildProcess.spawn (/bin/sh -c pwd)`
- tool-detection loop (`git go gcc make …`) → same `NotFound`
- CPU/memory/disk probes → same `NotFound`
- `/bin/bash -c 'echo shell test'` → same `NotFound`

### Network/API commands (executed, all succeeded)

- GitHub REST checks for: `cosmos/evm`, `evmos/os`, `evmos/evmos`,
  `evmos/ethermint`, `ava-labs/subnet-evm`, `cosmos/cosmos-sdk`,
  `cometbft/cometbft` → status 200, metadata recorded.
- Tags/releases: `cosmos/evm` v0.7.3 (2026-09-03) selected; v1.0.0-rc2 noted
  (pins an older stack: SDK v0.53.0 / CometBFT v0.38.17).
- Commit refs: tag refs resolved to commit SHAs (recorded in `upstream.md`).
- Raw files fetched from the pinned tree: `go.mod`, `LICENSE`, `Makefile`,
  `local_node.sh`, `docker-compose.yml`, `AGENTS.md`, `CHANGELOG.md`,
  `README.md`, `.gitmodules`, `evmd/README.md`, `evmd/go.mod` — all 200.
- Directory listings: root, `evmd/`, `docs/`, `docs/audits/`, `tests/`, `x/` —
  all 200.
- **Documentation sources fetched:** Release Families page, v0.55 upgrade
  guide, security-audits page, PreciseBank docs page, 2026.1 blog — all 200.
- **Go module proxy:** `v0.7.3` confirmed as the latest published version —
  https://proxy.golang.org/github.com/cosmos/evm/@latest (200).

## 4. Tests — separation of "not run" vs "failed"

**The only failures observed were environment-level spawn failures (no shell),
not test failures.** No test of the chain software was ever started, so nothing
can be reported as a passing or failing test.

- **Failed (environment only):** every attempted shell invocation (section 3).
- **Not run (blocked by no toolchain):**
  `make build`, `make test`, `make test-rpc-compat`, `make test-solidity`,
  `make benchmark`, `make vulncheck`, Foundry/Hardhat suites, 4-node localnet
  (`make localnet-start`), and any JSON-RPC probe.
- **First executable acceptance tests (Phase 1):**
  1. clean-clone build of v0.7.3;  2. `evmd` produces blocks;
  3. `eth_chainId` / `eth_blockNumber` answer;  4. a Solidity contract
     deploys and is called;  5. 4-node `localnet` reaches consensus.

## 5. Problems and current blockers

1. No shell / no toolchain in this distroless sandbox → build impossible here.
2. Installing tooling is **not permitted in this environment** and is subject
   to owner approval on an external host.
3. Go 1.25.9 is required (recent toolchain) — must be provisioned deliberately.
4. Docker path for 4 validators may be unavailable; fallback is a manual
   multi-home CometBFT setup (additional authored work).
5. **Open alignment gap:** no `cosmos/evm` tag pins the currently listed
   family combination (SDK 0.55.x / CometBFT 0.40.x); re-evaluate at Phase 2
   (candidate: v0.8.0) — no dependency change made.
6. Audit scope unverified in detail (exact audited commit in the PDF, `U`).
7. `/root` and `/home/nonroot` unreadable from this sandbox (permission).

## 6. Files created or modified (all inside `nexora/`)

| File | Kind | Content |
|---|---|---|
| `README.md` | modified (mine) | identity + baseline + constraints |
| `SPEC.md` | created | master spec, corrected, with rules & gates |
| `THREAT_MODEL.md` | created | 13 threats, mitigations, statuses |
| `ROADMAP.md` | created | Phases 0–8 with exit criteria |
| `docs/architecture-decision-record.md` | **modified (rev 2)** | ADR-0001 + release-family gap + audit-scope correction + decimal correction + sources |
| `docs/phase0-report.md` | **modified (this rev 2)** | corrected report |
| `docs/phase1-environment.md` | **created (2026-10-10)** | Linux environment requirements + verification checklist (no auto-installs) |
| `chain/upstream.md` | **modified (rev 2)** | pinned inventory, family mapping, precisebank, audit scope, source index |
| `.gitignore` | created earlier | excludes keys/state/build artifacts |

No user files were modified. No secrets or keys created. No external
deployment performed.

## 7. Separation: verified vs assumptions vs unverified

**Verified (`V`):** environment shape (no shell/toolchain); repo metadata and
licenses; v0.7.3 pins in `go.mod`; v0.7.3 as latest published module version
(Go proxy); docker-compose 4-node topology; release-family page contents;
v0.55 upgrade-guide contents; PreciseBank removal (PR #1019) and absence from
v0.7.3 tree; audit file presence and dates; README constraints; JSON-RPC flags.

**Assumed (`A`):** that a standard Linux host with the listed tooling can build
v0.7.3 without extra fixes; the interpretation that family 2026.1 was rolled
forward from 0.54/0.39 to 0.55/0.40; that the audit corresponds to the
July-2025 code state (dates are verified, the precise commit is not).

**Unverified (`U`):** any build, block production, contract deployment, RPC
behavior, TPS/finality numbers, 4-node consensus, recovery behavior; the exact
audited commit; the family-aligned tag (v0.8.0) contents — all deferred to
Phase 1/2 execution on real hardware.

## 8. First five tasks of the next phase (Phase 1) — awaiting approval + environment

Gate: **a real Linux host verified with `docs/phase1-environment.md` (Section
4 checklist), raw transcripts returned, and the owner's explicit approval.**
The current sandbox is never used for build commands.

1. T1 — Verify the target environment against the checklist in
   `docs/phase1-environment.md`; record versions (Git, **Go 1.25.9 exactly**,
   make, gcc, jq; Docker optional).
2. T2 — Clone and pin: `git clone https://github.com/cosmos/evm.git` then
   `git checkout c3ae9067a7eadcdea55a5192226916deb44c71c4`; confirm clean tree
   and `git describe --tags` → v0.7.3.
3. T3 — Build the **unmodified original**: `make build` (repo) and `make build`
   under `./evmd`; record outputs.
4. T4 — Run `./local_node.sh -y`; block production confirmed; JSON-RPC answers
   `eth_chainId`, `eth_blockNumber`, `net_version`.
5. T5 — Deploy and call a minimal Solidity contract via JSON-RPC; record
   transcript.

(After T5, optional separately-approved later steps: upstream `make test`,
`make test-rpc-compat`, `make test-solidity`, 4-node `make localnet-start`.
No NEXORA customization or consensus changes in Phase 1 — owner decision #6.)

## 9. Stopping point

Phase 0 is complete (rev 2) and the documentation phase is **closed** by owner
approval (2026-10-10). Per instructions, work **stops here**. Phase 1 will not
start until (a) a Linux environment verified against
`docs/phase1-environment.md` is provided and (b) the owner gives explicit
approval.