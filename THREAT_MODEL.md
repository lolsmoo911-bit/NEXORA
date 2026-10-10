# NEXORA Network — Threat Model

Version: 0.1.0 (Phase 0)
Method: lightweight STRIDE-style enumeration scoped to the prototype and its
planned path to mainnet. Each item records likelihood, impact, mitigations,
and verification status.

Legend — Status: `V` verified by evidence, `A` assumption, `U` unverified.

---

## Assets to protect

1. Validator signing keys and node identities.
2. Genesis file and chain configuration integrity.
3. User/issuer private keys and mnemonics.
4. Smart-contract correctness and access control.
5. Consensus liveness and safety.
6. Reputation/legal claims of asset backing.
7. Supply chain (dependencies, build reproducibility).

## Trust boundaries

- Local dev environment (untrusted network, test keyring only).
- Upstream dependencies (Cosmos EVM, Cosmos SDK, CometBFT, geth fork).
- AI coding agents (no key access; no merge authority over critical changes).
- Human operators (approval gate for critical merges).

---

## TM-01 — Premature mainnet / token launch

**Description:** Launching a network or token before the technology is proven,
creating financial and legal exposure.
**Likelihood:** High. Impact: High.
**Mitigations:** Mainnet release gate in `SPEC.md` §12; no production keys or
external deployment in Phase 0; explicit human approval. Status: policy `V`.

## TM-02 — Stale or vulnerable EVM execution engine

**Description:** The EVM is a Cosmos **fork** of go-ethereum
(`github.com/cosmos/go-ethereum v1.17.2-cosmos-0`, branch `release/1.17`).
Fork divergence and upstream geth advisories must be tracked.
**Likelihood:** Medium. Impact: High.
**Mitigations:** Pin exact fork version; never silently upgrade; run
`govulncheck`; monitor both geth and Cosmos fork advisories; fuzz and RPC
compat tests before mainnet. Status: `V` (fork pin verified in go.mod).

## TM-03 — Smart-contract vulnerabilities

**Description:** Reentrancy, access-control flaws, arithmetic errors in asset
and registry contracts.
**Likelihood:** Medium. Impact: High (contract scope).
**Mitigations:** Minimal contracts first; Solidity tests (Foundry + Hardhat);
lint (solhint/slither upstream); fuzzing; independent review for critical
changes. Status: planned.

## TM-04 — Validator key compromise

**Description:** Leakage or theft of signing keys; double-signing.
**Likelihood:** Medium. Impact: Critical (consensus).
**Mitigations:** Never commit keys; `.gitignore` rules; devnets use `test`
keyring only; production keys require HSM/KMS and separate operational design
before mainnet; key rotation and remote-signer plan in later phases.
Status: policy `V`.

## TM-05 — Genesis / configuration misuse

**Description:** Chain-id collision, wrong denomination/decimals, wrong genesis
parameter, non-deterministic genesis.
**Likelihood:** Medium. Impact: High.
**Mitigations:** 18-decimal base denomination convention; collision check for
chain-id; deterministic genesis script; `validate-genesis`; review of every
genesis-change PR. Status: planned.

## TM-06 — 18-decimal token constraint

**Description:** Upstream supports **only 18-decimal** gas-token chains
(README). A non-conforming denom silently breaks fee/gas math.
**Likelihood:** Medium. Impact: High.
**Mitigations:** Use an 18-decimal base denom (e.g. `anex` = 1e-18 NEX);
enforce in genesis; document in economics. Note: `x/precisebank` (the former
6→18-decimal bridge) is **removed** upstream (PR #1019, 2026-03-02) and absent
from the pinned tree — no runtime bridge is available for a non-18-decimal
denom (see `chain/upstream.md` §5). Status: `V` (README constraint).

## TM-07 — Dependency supply chain

**Description:** Tampered/malicious dependency, unpinned build, non-reproducible
binary.
**Likelihood:** Low–Medium. Impact: High.
**Mitigations:** Commit `go.mod`/`go.sum`; `go mod verify`; license inventory;
vendoring option; CI on a pinned toolchain; no silent bumps. Status: planned.

## TM-08 — Reserve/backing misrepresentation

**Description:** Users or issuers imply tokens are backed by physical assets.
**Likelihood:** Medium. Impact: High (legal/reputational).
**Mitigations:** Registry/identity never asserts physical existence; explicit
wording in specs and UI; reserve attestation is only a reference, not a claim.
Status: policy `V`.

## TM-09 — AI agent over-reach

**Description:** An agent merges critical changes, touches keys, or deploys.
**Likelihood:** Medium. Impact: High.
**Mitigations:** Agents produce diffs/tests only; human approval for consensus,
genesis, crypto, permissions, upgrades, deployment; agents never see signing
keys. Status: policy `V`.

## TM-10 — Transaction replay / chain-id confusion

**Description:** Replayed transactions across chains due to incorrect chain-id
or signing domain.
**Likelihood:** Low. Impact: Medium.
**Mitigations:** Distinct chain-id; EIP-155 and EIP-712 handling verified in
tests; chain-id change tests. Status: planned.

## TM-11 — RPC / DoS exposure

**Description:** Publicly exposed JSON-RPC abused to exhaust resources; state
growth.
**Likelihood:** Medium (post-exposure). Impact: Medium.
**Mitigations:** Bind RPC locally during dev; rate limits, auth, and pruning
strategy before any public endpoint; monitor. Status: planned.

## TM-12 — Upstream audit scope mismatch

**Description:** The upstream Sherlock audit (2025-07-28) covers the
**July-2025 codebase state (≈v0.3.x era)** of upstream Cosmos EVM — **not**
release v0.7.3 (which shipped ~14 months later) and **not** NEXORA's future
customizations. Relying on it as if it covers v0.7.3 or our code would be false
assurance. The exact audited commit is unverified (`U`; printed in the PDF).
**Likelihood:** High (if misunderstood). Impact: High.
**Mitigations:** Track audit as scope-limited evidence (July-2025 revision);
read the exact audited commit before any scoped claim; require new review for
every NEXORA-specific change (AID, registry, config); document scope. Status: `V`.

## TM-13 — Legal / trademark exposure

**Description:** "NEXORA"/"NEX" may conflict with existing marks; asset-token
operations may trigger securities/AML obligations.
**Likelihood:** Medium. Impact: High.
**Mitigations:** No trademark assertion until clearance; no public token; legal
review before any asset-backed offering. Status: open / unverified.

---

## Known-unverified items (must not be presented as facts)

- `U` Whether the whole stack builds on a non-standard toolchain version.
- `U` Actual TPS, finality, and resource use (no benchmark executed yet).
- `U` Whether the upstream 4-node localnet runs cleanly on the target host.
- `U` Applicability of the upstream audit to release v0.7.3 specifically.