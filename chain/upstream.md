# Upstream Inventory, Versions & Compatibility

> Verified during Phase 0 via the GitHub REST API, the official Go module proxy,
> the Cosmos EVM repository, and the official Cosmos documentation.
> **Do not silently change any revision here.** Any bump requires written
> rationale plus human review of consensus/genesis/execution/storage/crypto.
> Legend: `V` verified, `A` assumption, `U` unverified, `—` not applicable.

## 1. Selected reference implementation

| Field | Value | Source |
|---|---|---|
| Repository | `https://github.com/cosmos/evm` | GitHub (`V`) |
| License | **Apache-2.0** | `LICENSE` file + GitHub API `license.spdx_id` (`V`) — https://github.com/cosmos/evm/blob/main/LICENSE |
| Description | "An EVM compatible framework for blockchain development with the Cosmos SDK" | GitHub (`V`) |
| Default branch | `main` @ `045a6efd11b353385686730ac5c71ea134983dd3` (2026-10-02) | GitHub (`V`) |
| **Pinned release** | **v0.7.3** (published 2026-09-03) | https://github.com/cosmos/evm/releases/tag/v0.7.3 (`V`) |
| **Pinned commit** | **`c3ae9067a7eadcdea55a5192226916deb44c71c4`** | GitHub tag ref + Go proxy (`V`) |
| Latest module version (Go proxy) | `v0.7.3` @ `c3ae9067…`, 2026-09-03 | https://proxy.golang.org/github.com/cosmos/evm/@latest (`V`) |
| Library module | `github.com/cosmos/evm` | `go.mod` (`V`) |
| Example chain module | `github.com/cosmos/evm/evmd` | `evmd/go.mod` (`V`) |
| Example chain binary | `evmd` | `evmd/README.md` (`V`) |
| Example chain-id | `cosmos_262144-1` | `evmd/README.md` (`V`) |
| Example denom | `atest` | `evmd/README.md` (`V`) |
| Permissioning | permissionless, all precompiles enabled | `evmd/README.md` (`V`) |

### Production usage claims (source-linked)

The upstream README states Cosmos EVM is "used by Ondo, Mezo, Mantra, XRP
sidechain, Telegram Application Chain (TAC), Stable, and others."
Source: https://github.com/cosmos/evm#readme (`V` — claim as published by
upstream; NEXORA has not independently verified each deployment).

## 2. Pinned dependency versions (from v0.7.3 `go.mod`)

| Component | Version | Note |
|---|---|---|
| Go toolchain | **1.25.9** | upstream build requirement (`V`) |
| Cosmos SDK | v0.54.3 | (`V`) |
| Cosmos SDK store | `cosmos/cosmos-sdk/store/v2 v2.0.0` | (`V`) |
| CometBFT | v0.39.3 | (`V`) |
| IBC | `cosmos/ibc-go/v11 v11.0.0` | (`V`) |
| go-ethereum (declared) | v1.16.8 | (`V`) |
| go-ethereum (`replace`) | `github.com/cosmos/go-ethereum v1.17.2-cosmos-0` | Cosmos geth fork (`V`) |
| keyring (`replace`) | `github.com/cosmos/keyring v1.2.0` | (`V`) |
| gin (`replace`) | v1.9.1 | GHSA-h395-qcrw-5vmq (`V`) |
| btree (`replace`) | `github.com/cosmos/btree v0.0.0-20250924232609-2c6195d95951` | BSTM (`V`) |
| Retraction | `retract v0.4.0` | do not use v0.4.0 (`V`) |

Source: https://github.com/cosmos/evm/blob/v0.7.3/go.mod

### Dependency history across release lines (verified)

| Line | Cosmos SDK | CometBFT | Go | Source |
|---|---|---|---|---|
| v0.6.x | v0.53.6 | v0.38.21 | 1.23.8 | `release/v0.6.x/go.mod` (`V`) |
| **v0.7.x (incl. v0.7.3)** | **v0.54.3** | **v0.39.3** | **1.25.9** | `release/v0.7.x` / `v0.7.3` (`V`) |
| `main` (2026-10-02) | v0.54.3 | v0.39.3 | 1.25.9 | `main/go.mod` (`V`) |
| v1.0.0-rc2 | v0.53.0 | v0.38.17 | 1.23.8 | `v1.0.0-rc2/go.mod` (`V`) |

> Note: `v1.0.0-rc2` pins an **older** stack than v0.7.3 despite its higher
> version number; it is not a forward version. Source:
> https://github.com/cosmos/evm/blob/v1.0.0-rc2/go.mod (`V`).

## 3. Release-family compatibility (the flagged discrepancy)

> **OWNER-CONFIRMED OPEN ISSUE (2026-10-10):** this gap stays open. No
> dependency changes and no move to an untagged revision without a documented,
> owner-reviewed decision.

**Question raised:** the canonical release-family guide lists Cosmos SDK v0.55.x
and CometBFT v0.40.x for Cosmos EVM 0.7.x, while v0.7.3's `go.mod` pins SDK
v0.54.3 and CometBFT v0.39.3.

**Verified findings:**

1. The **canonical Release Families page** (marked "canonical source of truth")
   currently lists family **2026.1** as:
   `Cosmos SDK 0.55.x`, `CometBFT 0.40.x`, `Cosmos EVM 0.7.x`, `IBC Go v11.x.y`
   (plus enterprise Group/PoA 1.x.y and other components).
   Source: https://docs.cosmos.network/sdk/latest/release-family (`V`).
   The same page lists previous family **2025.1** as SDK 0.53.x / CometBFT
   0.38.x / Cosmos EVM 0.6.x / IBC v10.x.y (`V`).

2. The **official 2026.1 announcement blog** states the family ships
   "**CometBFT v0.39**, ... **Cosmos SDK v0.54**, ... **Cosmos EVM v0.7.0**".
   Source: https://cosmos.network/blog/cosmos-ledger-20261 (`V`).

3. The **v0.7.0 release notes** literally say "2026.1 release family dependency
   updates", and its `go.mod` pins SDK v0.54.3 / CometBFT v0.39.3.
   Source: https://github.com/cosmos/evm/releases/tag/v0.7.0 (`V`).

4. The **v0.55 upgrade guide** states Cosmos SDK v0.55 requires CometBFT
   `v0.40.0`, and that "the v0.54.x line shipped with `v0.39.x`, ending at
   `v0.39.3` in v0.54.3". Source:
   https://docs.cosmos.network/sdk/latest/upgrade/v0.55 (`V`).

5. The **Release Families page itself** says: "Supported versions within a
   release family are updated over time" and "A component version is supported
   only when it appears in an active release family."
   Source: https://docs.cosmos.network/sdk/latest/release-family (`V`).

**Analysis (`A`, clearly an interpretation, not a primary-source quote):**
Release family 2026.1 was announced (blog + v0.7.0) on **SDK 0.54 / CometBFT
0.39**, and the family page has since been **rolled forward to SDK 0.55 /
CometBFT 0.40** while keeping the "Cosmos EVM 0.7.x" row. No tagged
`cosmos/evm` release yet pins SDK 0.55 / CometBFT 0.40 — neither v0.7.3 nor
`main` does (verified above). A `docs/migrations/v0.7.x_to_v0.8.0.md` exists on
`main`, indicating **v0.8.0 is in preparation**; the family-aligned artifact
may arrive as v0.8.0 (or a forthcoming v0.7.x patch). Source:
https://github.com/cosmos/evm/blob/main/docs/migrations/v0.7.x_to_v0.8.0.md (`V`).

**Consequence for pinning (must be stated honestly):** under the family
policy's strict wording, **Cosmos SDK v0.54.3 / CometBFT v0.39.3 do not appear
in the currently listed active family** (2026.1 shows 0.55.x/0.40.x; 2025.1
shows 0.53.x/0.38.x). Cosmos EVM **0.7.x** *is* in 2026.1. The clean,
family-aligned target is therefore "Cosmos EVM 0.7.x + SDK 0.55.x + CometBFT
0.40.x", but **no `cosmos/evm` tag currently pins that combination**. This is an
open alignment gap (`U` until a tagged artifact exists).

## 4. Audit scope (correction)

| Item | Value | Source |
|---|---|---|
| Report file in tree | `docs/audits/sherlock_2025_07_28_final.pdf` | present at `v0.7.3` (`V`) |
| Auditor | Sherlock | https://docs.cosmos.network/sdk/latest/security/audits (`V`) |
| Date | **2025-07-28** | filename + commit history (`V`) |
| Added to repo | 2025-07-28 (commits #365/#366) | `git` history via GitHub API (`V`) |
| Release tag that era | `v0.3.0`, cut 2025-07-25 from branch `audit/all` | GitHub releases API (`V`) |
| Cover v0.7.3? | **No** — audit predates v0.7.3 (~14 months) | inference (`A`) |
| Exact audited commit | **Not established here** | `U` |

**Correction:** the audit **must not** be represented as an audit of v0.7.3.
It corresponds to the **July-2025 codebase state** (the v0.3.x era). The file
happens to be shipped inside later tags, which is why it can be misread as
covering them. The exact audited commit is printed in the PDF and must be read
in a tooled environment before making any scoped claim (`U`).

## 5. 18-decimal gas token and `x/precisebank` (correction)

| Fact | Value | Source |
|---|---|---|
| Upstream policy | "Cosmos EVM supports 18-decimal EVM gas-token chains. Non-18-decimal configurations are not supported." | https://github.com/cosmos/evm#readme (`V`) |
| `x/precisebank` in the pinned tree (v0.7.3) | **Not present** (`x/` contains only `erc20`, `feemarket`, `ibc`, `vm`) | GitHub contents API (`V`) |
| History | Removed by PR #1019 "chore!: Remove x/precisebank" (merged 2026-03-02); also `contrib/x/precisebank` removed | https://github.com/cosmos/evm/pull/1019 (`V`) |
| v0.8.0 plan | "removes the deprecated `contrib/x/precisebank` module and standardizes on 18-decimal"; "Non-18-decimal gas-token chains are not supported in v0.8.0"; requires `EvmCoinInfo.Decimals = 18` | https://github.com/cosmos/evm/blob/main/docs/migrations/v0.7.x_to_v0.8.0.md (`V`) |
| PreciseBank docs page | Still describes the module (extends 6→18 decimals; required only for non-18-decimal native tokens) | https://docs.cosmos.network/evm/latest/documentation/cosmos-sdk/modules/precisebank (`V`, but **documentation/code drift**) |

**Correction / guidance:** "18-decimal only" is the modeled and enforced policy
of the current line. `x/precisebank` (which bridged 6→18 decimals so that a
non-18-decimal native token could still work with the EVM) has been **removed**
from the `cosmos/evm` repository and is **not shipped in v0.7.3**. The official
docs page describing it is **stale** relative to the code (verified: the module
path returns 404 in the pinned tree). Therefore NEXORA should adopt an
**18-decimal base denomination** (e.g. `anex`, atto = 10^18; 1 NEX = 10^18
`anex`), which needs **no** PreciseBank. Choosing a non-18-decimal denom would
require an unsupported, removed module and must not be planned for.

## 6. Build & run requirements (to be installed only with user approval)

| Requirement | Purpose | Present in this sandbox |
|---|---|---|
| Git | clone/pin | **absent** |
| Go 1.25.9 | compile `evmd` | **absent** |
| make, gcc, build-essential | build | **absent** |
| jq | `local_node.sh` genesis edits | **absent** |
| Docker + Compose | 4-node `localnet` (`evmdnode0..3`) | **absent** |
| Node.js >= 22 + Yarn/npm | Hardhat/JS contract tests | **absent** |
| Foundry (`forge`, `cast`, `anvil`) | Foundry contract tests + submodules | **absent** |
| Python 3 + tox | upstream script/lint tests | **absent** |

Source (Node >= 22): Cosmos EVM `CHANGELOG.md` UNRELEASED (#1250) (`V`).

## 7. JSON-RPC surface

`local_node.sh` starts the node with
`--json-rpc.api eth,txpool,personal,net,debug,web3` (`V`).
Conventional endpoints: HTTP 8545, WS 8546, CometBFT RPC 26657, gRPC 9090,
REST 1317, P2P 26656 (`A`, Cosmos/CometBFT convention).

## 8. Eliminated / archived alternatives (evidence)

| Candidate | Status | Evidence & source |
|---|---|---|
| `evmos/ethermint` | **Archived** 2024-04-04 | GitHub API `archived: true` (`V`) |
| `ava-labs/subnet-evm` | **Archived** 2025-12-15 | GitHub API `archived: true` (`V`) |
| `evmos/evmos` | **Non-commercial license** | `LICENSE` = "Evmos Non-Commercial License 1.0"; GitHub API `NOASSERTION` (`V`) |
| `evmos/os` | Apache-2.0 but **stale, no tags** | `main` HEAD `d14323f1…` (2025-03-18); empty tags/releases (`V`) |

## 9. Source index

- Repo & license: https://github.com/cosmos/evm • https://github.com/cosmos/evm/blob/main/LICENSE
- v0.7.3: https://github.com/cosmos/evm/releases/tag/v0.7.3 • go.mod: https://github.com/cosmos/evm/blob/v0.7.3/go.mod
- Release families: https://docs.cosmos.network/sdk/latest/release-family
- SDK v0.55 (CometBFT 0.40): https://docs.cosmos.network/sdk/latest/upgrade/v0.55
- Security policy: https://docs.cosmos.network/sdk/latest/security/security-policy
- Security audits: https://docs.cosmos.network/sdk/latest/security/audits
- RF 2026.1 blog: https://cosmos.network/blog/cosmos-ledger-20261
- PreciseBank docs (stale): https://docs.cosmos.network/evm/latest/documentation/cosmos-sdk/modules/precisebank
- v0.8.0 migration: https://github.com/cosmos/evm/blob/main/docs/migrations/v0.7.x_to_v0.8.0.md
- Go module proxy: https://proxy.golang.org/github.com/cosmos/evm/@latest