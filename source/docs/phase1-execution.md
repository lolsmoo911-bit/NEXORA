# Phase 1 — Execution Path to the First Working Chain

**Next technical goal (owner-approved, unchanged scope):** build the **unmodified**
Cosmos EVM reference (`cosmos/evm` @ `c3ae9067a7eadcdea55a5192226916deb44c71c4`,
tag `v0.7.3`), run its local node, verify JSON-RPC, and deploy a simple Solidity
contract. No NEXORA customization, no consensus/dependency changes, no
production keys, no mainnet, no paid resources.

## Why GitHub Actions is the shortest free path

The current agent sandbox has **no shell, no Go toolchain, and ~450 MB disk** —
it cannot build/run the chain. The NEXORA repo (public, on GitHub) already
includes a free CI runner (`ubuntu-24.04`: Git, Go 1.25.9, make, gcc, jq, ~50 GB
disk, HTTPS to github.com + proxy.golang.org) which satisfies every item of
`docs/phase1-environment.md`. Public-repo Actions usage on standard runners is
**$0**. No server purchase, no paid service.

## How it is triggered

`.github/workflows/phase1-reference-verify.yml` runs on `workflow_dispatch` (manual)
and on pushes touching `ci/**`, `contracts/**`, or the workflow itself. It:

1. Sets up **Go 1.25.9** (`go.mod` of root and `evmd` both declare `go 1.25.9`).
2. Clones tag `v0.7.3` and asserts `HEAD == c3ae9067a7eadcdea55a5192226916deb44c71c4`.
3. Runs the **unmodified** `make install` (upstream Makefile) → `evmd` binary.
4. Runs the **unmodified** upstream `./local_node.sh -y --no-install` with
   `CHAIN_ID=cosmos_262144-1`.
5. Verifies JSON-RPC and deploys `contracts/src/NexoraGreeter.sol`
   (`ci/verify-reference-chain.sh`).

## Deterministic expected values (verified from source)

| Check | Expected | Source |
|---|---|---|
| `eth_chainId` | `0x40000` | `server/config/config.go` → `DefaultEVMChainID = 262144` |
| `net_version` | `262144` | same constant |
| `eth_blockNumber` | advances (block time 1 s) | `local_node.sh` timeout tuning |
| deployed `NexoraGreeter.greet()` | `Hello NEXORA` | our constructor arg |
| deploys from | `dev0` (genesis-funded test account) | upstream `local_node.sh` |

Test keys are the **public dev mnemonics published upstream** in `local_node.sh`
(`# gitleaks:allow`); the private key is exported at runtime with
`evmd keys unsafe-export-eth-key dev0` — nothing is committed to this repo.

## Transcripts

Every command's output and raw JSON-RPC responses are written to
`ci-artifacts/` and uploaded as a CI artifact (`phase1-transcripts`). The root
verification record is `docs/phase1-report.md`.

## Remaining external dependency

GitHub Actions must be **enabled** for the account/repo (verified: currently
**enabled**, allowed actions `all`). If a future run is disabled, the fix is a
one-time setting in the repo UI — not a purchase.