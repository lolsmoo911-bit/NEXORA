# NEXORA Network — Master Specification (SPEC)

Version: 0.1.0 (Phase 0)
Status: PROVISIONAL — supersedes neither user master spec nor later ADRs.

## 1. Purpose

Define NEXORA, an independent, EVM-compatible Layer 1 blockchain intended for
asset-oriented smart contracts and financial applications, with a verifiable
Asset Identity (AID) scheme as its differentiating feature.

Build everything from open-source components with a $0 cash budget during
development. The first objective is a **reproducible, working local chain** —
not a website, not a token launch, not a mainnet.

## 2. Identity (provisional)

| Field | Value | Note |
|---|---|---|
| Network | NEXORA Network | trademark/domain review outstanding |
| Native gas token | NEX (provisional symbol) | no claim of availability |
| Asset identity standard | AID — Asset Identity | design starts after base chain is verified |
| Category | Independent Layer 1 blockchain | |
| Compatibility target | Ethereum Virtual Machine (EVM) | Solidity + EVM tooling |
| Baseline duplex | Cosmos EVM + Cosmos SDK + CometBFT | Apache-2.0 |

## 3. Non-negotiable rules

1. Never write a new consensus protocol from scratch for the prototype.
2. Never invent repository paths, commands, APIs, or dependency capabilities.
3. Inspect upstream documentation and repository files before implementation.
4. Pin exact dependency versions and record the rationale (`chain/upstream.md`).
5. Never silently upgrade consensus, execution, storage, cryptographic, or
   genesis-related dependencies; each bump requires written rationale and human
   review.
6. Never commit private keys, mnemonics, passwords, or production secrets.
7. Never give an AI agent control over validator keys, production funds,
   consensus upgrades, or deployment approvals.
8. No production contracts or mainnet without explicit human approval.
9. Never claim asset-backed tokens without independent evidence.
10. Keep all early experiments local and labeled experimental.
11. Maintain reproducible builds, tests, threat model, and known limitations.
12. Report limitations instead of fabricating results.
13. Only **18-decimal** gas-token chains are supported by the chosen baseline;
    monetary design must conform.

## 4. Reference baseline

Selected reference implementation: **Cosmos EVM** `github.com/cosmos/evm`,
release **v0.7.3** (commit `c3ae9067a7eadcdea55a5192226916deb44c71c4`),
Apache-2.0. Decision and alternatives in `docs/architecture-decision-record.md`.

> **Status (owner-confirmed 2026-10-10):** v0.7.3 is a **candidate** for the
> unmodified Phase 1 reference build, **not** a final stable designation of
> the NEXORA engine. The Release Family 2026.1 alignment gap remains an open
> issue — no dependency changes and no move to an untagged revision without a
> documented decision (see `docs/architecture-decision-record.md`).

Initial work uses the upstream `evmd` example chain **unmodified**. Any
NEXORA-specific configuration (chain-id, denominations, genesis, binary name)
is deferred until the unmodified reference chain builds and runs.

## 5. Initial chain requirements (local devnet)

- Reproducible build and documented configuration.
- Unique chain-id after collision checks.
- Native gas asset **NEX** with an 18-decimal base denomination (e.g. `anex`),
  parameters documented in `docs/economics.md` later.
- ≥4 local validator nodes — upstream `docker-compose.yml` provides 4 nodes
  (`evmdnode0..3`); requires Docker. Fallback: manual multi-home CometBFT setup.
- Block production and finality.
- Balances and native transfers.
- Solidity deployment/execution.
- Ethereum-compatible JSON-RPC (`eth,txpool,personal,net,debug,web3` surface).
- Solidity compile/test (upstream ships Foundry **and** Hardhat harnesses).
- Deterministic genesis procedure and node restart/recovery procedure.
- Basic monitoring/log collection.

## 6. AID — Asset Identity (IMPLEMENTED AND VERIFIED — see aid/SPEC.md)

Target: a versioned, deterministic identity standard for contracts
representing assets. Canonical encoding fields:

- Standard version; Chain ID; Issuer; Asset class; Name & symbol;
  Metadata content hash; Factory; Init-code hash; optional issuance series.

Rules:
- It is an **identity and verification** mechanism, not proof of physical
  ownership.
- Use Ethereum-compatible primitives; avoid ambiguous concatenation of
  variable-length strings; derive a deterministic `assetId`.
- Document the difference between asset identity, contract address, issuer
  identity, and evidence of reserves.
- **Gate:** AID work begins only after the reference chain is verified and a
  human approves entering Phase 5 (per `ROADMAP.md`).

## 7. Vanity addresses via CREATE2 (IMPLEMENTED AND VERIFIED — see docs/phase5-report.md)

Standard formula:

```
address = last20bytes(keccak256(0xff ++ factory ++ salt ++ initCodeHash))
```

`salt` derived from the AID identity and an explicit counter. Build a local
search tool with honest complexity estimates, attempt/time limits, independent
verification, and a hard rule: a vanity address never proves authenticity or
reserve backing. Addresses stay 20-byte EVM format; human-readable names live
in metadata/explorer, not in hex.

## 8. Asset registry (IMPLEMENTED AND VERIFIED — see docs/phase5-report.md)

Minimal AID Registry contract/module: asset id, contract address, issuer,
name/symbol, class, metadata hash, version, timestamp, optional
reserve-attestation reference, status/version history. Role-based access
control and event logs. Registration ≠ proof of physical existence. No bridges,
custom precompiles, or consensus changes at this stage.

## 9. Security & testing

Targeted test strategy: unit, integration, Solidity (Foundry/Hardhat), fuzz,
state-transition, genesis/migration, replay/chain-id, gas accounting, RPC
compatibility (upstream `test-rpc-compat`), validator failure/partition,
recovery, contract access control, CREATE2 verification, AID encoding edge
cases, dependency/build reproducibility. Parallel-execution only after a
documented design + benchmark demonstrates need. Maintain `THREAT_MODEL.md`
and a public known-limitations list.

## 10. Agent workflow

Separate workstreams (protocol/chain/AID/contracts/security/ops). Tasks carry:
issue, plan, dedicated branch, tests, review diff, written report. A security
reviewer other than the author must examine changes. Human approval before any
merge touching consensus, genesis, crypto, permissions, upgrades, or
deployment. Agents never hold signing keys.

## 11. Phases and gates

See `ROADMAP.md`. Summary: 0 recon → 1 unmodified reference chain →
2 validated chain config → 3 multi-validator + recovery → 4 AID spec/impl →
5 registry → 6 compat/perf/fuzz/security → 7 public testnet (only with
infrastructure/operators) → 8 production readiness, audit plan, governance,
budget. A phase is complete only when its acceptance criteria are verified.
**Phase 1 is restricted (owner decision #6) to building and running the
unmodified original, testing JSON-RPC, and deploying a simple Solidity
contract — no NEXORA customization and no consensus changes.**

## 12. Mainnet release gate

No mainnet until: EVM+RPC compatibility tested; sustained public testnet;
failure/recovery proven; critical/high findings resolved; independent security
review (note: upstream Sherlock audit exists but covers upstream, not NEXORA
customization); documented genesis/upgrade procedures; secure key management;
incident response; validator admission & decentralization goals; operational
budget; legal review for any asset-backed tokens. Passing AI-generated tests
alone does not satisfy the gate.

## 13. Deliverables (repository)

`README.md`, `SPEC.md`, `THREAT_MODEL.md`, `ROADMAP.md`,
`docs/architecture-decision-record.md`, `docs/economics.md` (later),
`docs/validator-guide.md` (later), `docs/security-policy.md` (later),
`chain/upstream.md`, automated tests, reproducible local-dev script,
benchmark script + results, dependency/license inventory, known-issues list.