# ADR-0001 — Selection of the NEXORA reference chain baseline

- Status: Accepted (Phase 0), subject to Phase 1 build verification
- Date: 2026-10-09/10 (rev. 2 — release-family, audit-scope, decimal and
  source-citation corrections)
- Deciders: project owner (human) + engineering agent (recommendation)

## Context

NEXORA needs an EVM-compatible Layer 1 baseline that is (a) permissively
licensed, (b) actively maintained, (c) Cosmos-SDK + CometBFT based (per the
project brief), (d) runnable locally at $0, and (e) capable of the multi-node
and JSON-RPC requirements. The original brief named "Cosmos EVM" and named
Avalanche L1/Subnet-EVM as an alternative. The owner explicitly instructed not
to default to `evmos/os` or any old release, and to inspect
`https://github.com/cosmos/evm`.

## Evidence collected (verified via GitHub API + official docs, 2026-10-09/10)

| Candidate | License | Latest activity | Cosmos SDK | EVM engine | Releases | Multi-node | Verdict |
|---|---|---|---|---|---|---|---|
| **cosmos/evm** | Apache-2.0 | 2026-10-02; stable v0.7.3 2026-09-03 | v0.54.3 (official) | geth fork v1.17.2-cosmos-0 (replace) | tagged v0.4–v0.7 + v1.0.0-rc | **4 nodes in `docker-compose.yml`** | **SELECTED** |
| evmos/os | Apache-2.0 | stale: main @ `d14323f` (2025-03) | v0.50.9-evmos (Evmos fork) | geth fork v1.10.26-evmos-rc4 (2024) | **none** (commit pin only) | none | Rejected (stale, no releases) |
| evmos/evmos | **Non-Commercial** | chain active; latest tag v20.0.0 | Evmos fork | Evmos geth fork | v20 | scripts | Rejected (license) |
| evmos/ethermint | LGPL-3.0 | **Archived** 2024-04-04 | old | old | n/a | n/a | Rejected (archived) |
| ava-labs/subnet-evm | LGPL-3.0 | **Archived** 2025-12-15 | n/a | Avalanche EVM | n/a | n/a | Rejected (archived) |
| Bespoke EVM/consensus | — | — | — | — | — | — | Forbidden by brief (no new consensus) |

**Source links for the license/version claims above**

- `cosmos/evm` LICENSE (Apache-2.0):
  https://github.com/cosmos/evm/blob/main/LICENSE
- `cosmos/evm` release v0.7.3:
  https://github.com/cosmos/evm/releases/tag/v0.7.3
- `cosmos/evm` v0.7.3 `go.mod` (dependency pins):
  https://github.com/cosmos/evm/blob/v0.7.3/go.mod
- `evmos/evmos` LICENSE (Non-Commercial):
  https://github.com/evmos/evmos/blob/main/LICENSE
- `evmos/os` repository (no tags):
  https://github.com/evmos/os
- `evmos/ethermint` (archived):
  https://github.com/evmos/ethermint
- `ava-labs/subnet-evm` (archived):
  https://github.com/ava-labs/subnet-evm

Additional verified facts for **cosmos/evm v0.7.3** (`c3ae9067…`):

- LICENSE file is the Apache License 2.0 (source above).
- `go.mod`: `go 1.25.9`; CometBFT v0.39.3; Cosmos SDK v0.54.3; `store/v2`
  v2.0.0; ibc-go v11; `go-ethereum` replaced by
  `github.com/cosmos/go-ethereum v1.17.2-cosmos-0` (branch `release/1.17`).
- Two Go modules: `github.com/cosmos/evm` (library) and
  `github.com/cosmos/evm/evmd` (example chain binary `evmd`).
- Example chain config: chain-id `cosmos_262144-1`, denom `atest`,
  permissionless, all precompiles.
- `local_node.sh` starts: `evmd start --pruning nothing
  --minimum-gas-prices=0atest --evm.min-tip=0 --json-rpc.api
  eth,txpool,personal,net,debug,web3`.
- `docker-compose.yml` defines **4 nodes** (`evmdnode0..3`); Make targets
  include `localnet-start`, `localnet-stop`, `test-rpc-compat`, `test-solidity`,
  `benchmark`, `vulncheck`.
- Tests present: `tests/{integration,jsonrpc,solidity,systemtests,speedtest,evm-tools-compatibility}`;
  `x/{vm,erc20,feemarket,ibc}`; broad precompile set.
- README states the framework is used by Ondo, Mezo, Mantra, XRP sidechain,
  TAC, Stable (source: https://github.com/cosmos/evm#readme — claim as
  published by upstream; NEXORA has **not** independently verified each
  deployment `A`).

## Release-family compatibility and support (the flagged discrepancy)

The owner flagged a conflict: the canonical release-family guide lists Cosmos
SDK **v0.55.x** and CometBFT **v0.40.x** for Cosmos EVM **0.7.x**, while the
pinned v0.7.3 `go.mod` says SDK **v0.54.3** and CometBFT **v0.39.3**. The
investigation confirms the conflict is **real and documented**, and no
dependency was changed.

**What the official sources say (verified):**

1. **Canonical Release Families page** — active family **2026.1** is listed as
   `Cosmos SDK 0.55.x`, `CometBFT 0.40.x`, `Cosmos EVM 0.7.x`, `IBC Go v11.x.y`.
   Previous family **2025.1** = SDK 0.53.x / CometBFT 0.38.x / Cosmos EVM
   0.6.x / IBC v10.x.y. The page calls itself the "canonical source of truth"
   and states: *"Supported versions within a release family are updated over
   time"* and *"A component version is supported only when it appears in an
   active release family."*
   Source: https://docs.cosmos.network/sdk/latest/release-family
2. **Official 2026.1 announcement blog** — states the family ships
   "**CometBFT v0.39** … **Cosmos SDK v0.54** … **Cosmos EVM v0.7.0**".
   Source: https://cosmos.network/blog/cosmos-ledger-20261
3. **v0.7.0 release notes** — say "2026.1 release family dependency updates",
   and the v0.7.x `go.mod` pins SDK v0.54.3 / CometBFT v0.39.3.
   Source: https://github.com/cosmos/evm/releases/tag/v0.7.0
4. **v0.55 upgrade guide** — states Cosmos SDK v0.55 requires CometBFT
   **v0.40.0**, and that "the v0.54.x line shipped with `v0.39.x`, ending at
   `v0.39.3` in v0.54.3".
   Source: https://docs.cosmos.network/sdk/latest/upgrade/v0.55
5. **`main` and `release/v0.7.x` `go.mod`** (checked directly) both still pin
   SDK **v0.54.3** / CometBFT **v0.39.3** — i.e. even the tip of the tree is
   **not** on the 0.55/0.40 combination yet.
6. A **`docs/migrations/v0.7.x_to_v0.8.0.md`** exists on `main`, indicating
   **v0.8.0 is in preparation**.
   Source: https://github.com/cosmos/evm/blob/main/docs/migrations/v0.7.x_to_v0.8.0.md

**Interpretation (`A` — analysis, not a quote):** family 2026.1 was announced
(blog + v0.7.0) on **SDK 0.54 / CometBFT 0.39**, and the family page has since
been rolled forward to **SDK 0.55 / CometBFT 0.40** while keeping the
"Cosmos EVM 0.7.x" row. A family-aligned `cosmos/evm` **tag** that pins
SDK 0.55 / CometBFT 0.40 **does not exist yet** (neither v0.7.3 nor `main`);
the aligned artifact is expected to be an upcoming release (candidate:
**v0.8.0**, migration doc present but unreleased).

**Support-policy consequence (stated honestly):** read strictly, SDK v0.54.3 /
CometBFT v0.39.3 are **not in the currently listed active family** (2026.1
shows 0.55.x/0.40.x; 2025.1 shows 0.53.x/0.38.x). Cosmos EVM **0.7.x** *is* in
2026.1. So the family-aligned target is
"Cosmos EVM 0.7.x + SDK 0.55.x + CometBFT 0.40.x", but **no `cosmos/evm` tag
currently pins that combination**. This is an **open alignment gap** (`U` until
such a tag exists).

## Audit scope (correction)

The audit **must not** be described as an audit of v0.7.3.

| Item | Value | Source |
|---|---|---|
| Report in tree | `docs/audits/sherlock_2025_07_28_final.pdf` | present at v0.7.3 (GitHub contents API) |
| Auditor | Sherlock | https://docs.cosmos.network/sdk/latest/security/audits |
| Date | **2025-07-28** | filename + commit history |
| Added to repo | 2025-07-28 (commits #365/#366) | GitHub commits API |
| Contemporaneous release | `v0.3.0`, cut 2025-07-25 from branch `audit/all` | GitHub releases API |
| Covers v0.7.3? | **No** — dated ~14 months before v0.7.3 (2026-09-03) | inference (`A`) |
| Exact audited commit | **Not established here** | `U` |

The PDF is shipped inside later tags, which invites the mistaken reading that
it covers them. It corresponds to the **July-2025 codebase state** (v0.3.x
era). The exact audited commit is printed in the PDF and must be read in a
tooled environment before any scoped claim (`U`). Note also that the
official security-audits page is auto-generated from `cosmos/security`.

## Decimal handling (correction)

The earlier note "supports 18-decimal gas tokens only" was correct but
incomplete. The precise situation:

- Upstream README: *"Cosmos EVM supports 18-decimal EVM gas-token chains.
  Non-18-decimal configurations are not supported."*
  Source: https://github.com/cosmos/evm#readme
- The **token decimal is a chain configuration** (`EvmCoinInfo.Decimals`), and
  a bridge module named `x/precisebank` (later `contrib/x/precisebank`) used to
  extend a 6-decimal native token to 18 decimals so a non-18-decimal chain could
  still serve the EVM. It was **removed** from `cosmos/evm`:
  - PR #1019 "chore!: Remove x/precisebank" merged 2026-03-02:
    https://github.com/cosmos/evm/pull/1019
  - The pinned **v0.7.3 tree does not contain it** (`x/` = `erc20`, `feemarket`,
    `ibc`, `vm` only).
  - The v0.8.0 migration explicitly "removes the deprecated
    `contrib/x/precisebank` module and standardizes on 18-decimal … Non-18-decimal
    gas-token chains are not supported in v0.8.0" and requires
    `EvmCoinInfo.Decimals = 18`:
    https://github.com/cosmos/evm/blob/main/docs/migrations/v0.7.x_to_v0.8.0.md
  - The public docs page describing PreciseBank is **stale** relative to the
    code: https://docs.cosmos.network/evm/latest/documentation/cosmos-sdk/modules/precisebank
- **Consequence for NEXORA:** adopt an **18-decimal base denomination**
  (e.g. `anex`, 1 NEX = 10^18 `anex`). No PreciseBank is needed or available;
  a non-18-decimal denom must **not** be planned for.

## Decision

Use **Cosmos EVM `github.com/cosmos/evm`, release v0.7.3, commit
`c3ae9067a7eadcdea55a5192226916deb44c71c4`**, with its `evmd` example chain as
the **candidate** unmodified reference baseline for Phase 1.

> **Status wording (owner-confirmed):** this is a **candidate** pending Phase 1
> build verification in a suitable execution environment — **not** a final
> designation of the NEXORA engine and **not** described as a "final stable
> release".

Why v0.7.3 (candidate): it is the latest **stable, non-prerelease** tag; it is
reproducible (confirmed as the latest module version by the official Go proxy:
https://proxy.golang.org/github.com/cosmos/evm/@latest); `main` moves
(`045a6efd…`, 2026-10-02) and `v1.0.0-rc2` pins an *older* stack
(SDK v0.53.0 / CometBFT v0.38.17) despite its higher number.

**Recommendation on alignment (see open gap above):** keep v0.7.3 for the
**Phase 1 reference build** (we only need to build the unmodified upstream),
then **re-evaluate at the start of Phase 2** whether a family-aligned
`cosmos/evm` tag pinning SDK 0.55.x / CometBFT 0.40.x now exists (candidate:
v0.8.0), and record the choice in a new/updated ADR. **Do not bump dependencies
ourselves.**

## Owner confirmation & adopted decisions (2026-10-10) — Phase 0 docs closed

The project owner reviewed the corrected Phase 0 report and adopted the
following six points verbatim. They are recorded here as binding constraints:

1. **v0.7.3 is a candidate, not a final stable release.** It remains the
   candidate for the unmodified Phase 1 reference build; it must never be
   presented as a final stable designation of the NEXORA engine.
2. **Release Family 2026.1 alignment gap stays an open issue.** No dependency
   changes and no move to an **untagged** revision without a documented,
   owner-reviewed decision.
3. **Sherlock audit scope is unproven.** It is not an audit of the current
   version until its scope and the exact audited code revision are proven.
4. **No build/test success may be claimed** for anything not actually
   executed with recorded outputs.
5. **The current execution environment has no Shell** → no build commands may
   be started there. A suitable Linux environment and a verification checklist
   are required first (see `docs/phase1-environment.md`), with no automatic
   installs or system changes.
6. **Phase 1 scope is limited** to building and running the **unmodified
   original**, testing JSON-RPC, and deploying a simple Solidity contract —
   no NEXORA customization, no consensus changes.

Recording location of these constraints: this record, `SPEC.md` (§4, §11),
`ROADMAP.md` (Phase 1), `docs/phase0-report.md`, `chain/upstream.md`,
`docs/phase1-environment.md`.

## Alternatives considered and rejected

- `evmos/os` — permissive but stale (geth 1.10.x, SDK v0.50.9-evmos, no
  releases); superseded by the official `cosmos/evm`.
- `evmos/evmos` — non-commercial license conflicts with an open, independent
  network (https://github.com/evmos/evmos/blob/main/LICENSE).
- `evmos/ethermint`, `ava-labs/subnet-evm` — archived.
- Building a custom EVM/consensus — prohibited by the brief and unjustified.

## Consequences

- Positive: official, Apache-2.0, modern toolchain, tagged releases, upstream
  audit on record, native 4-node localnet, broad test suite, real production
  adopters.
- Negative / costs: requires **Go 1.25.9** (new toolchain), Docker for the
  easiest 4-node path, and the gas token must be 18-decimal. The repo is
  pre-v1.0 (API may change between minor releases).
- Negative / open: the pinned combination (SDK 0.54.3 / CometBFT 0.39.3) sits
  **outside the currently listed 2026.1 family table** (0.55.x/0.40.x); a
  family-aligned tag is pending.
- Risk: EVM engine is a Cosmos fork of geth (divergence + advisory tracking);
  the upstream audit covers an **earlier** revision, not v0.7.3 or any NEXORA
  customization.

## Unresolved questions

1. Which exact commit did the Sherlock (2025-07-28) audit cover? (Read the PDF
   in a tooled environment.)
2. When will a `cosmos/evm` tag pinning SDK 0.55.x / CometBFT 0.40.x appear
   (v0.8.0 or a v0.7.x patch)?
3. Is Go 1.25.9 available/acceptable in the eventual dev environment?
4. Does the pinned build reproduce on the target host?
5. Is Docker available for the multi-node path, or is the manual fallback
   required?
6. When does stable v1.0.0 arrive, and does it justify a re-pin?
