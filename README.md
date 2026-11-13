# NEXORA

NEXORA is an EVM-compatible Layer 1 testnet project built on unmodified upstream components, with on-chain asset identity (AID), test contracts, and a deterministic market simulation core.

> **Status:** Testnet / local-verified development project. Not a financial product, not audited, not production-ready, and not a public network.

## Overview

NEXORA combines:

- **Chain:** Cosmos EVM-based devnet configuration (EVM Chain ID `902024`, `0xdc388`, denom `anex`)
- **AID (Asset Identity):** Deterministic asset identifier scheme and on-chain registry/factory contracts
- **Contracts:** Test-only Solidity contracts (token, sale vault, vesting, asset registry, CREATE2 deployer)
- **Market Core:** Pure, deterministic fixed-income/market simulation modules (pricing, curves, spreads, FX/crypto scenarios, simulation, state migration)

## Repository Structure

| Path | Description |
|---|---|
| `source/chain/` | Chain configuration (devnet parameters) |
| `source/ci/` | CI and local/testnet verification scripts |
| `source/aid/` | AID spec, implementations, contracts, and tests |
| `source/contracts/` | Solidity contracts and Foundry tests |
| `source/market/` | Canonical market simulation core (JS/ESM) and tests |
| `source/workbench/` | Research/compatibility/integration workbench modules |
| `source/docs/` | Technical documentation and status reports |
| `artifacts/` | API server and related application artifacts |
| `apps/` | Application packages (where present) |

## Current Verified State (Local)

- Phase 5 contracts deployed and exercised on a local NEXORA devnet (single-validator)
- Phase 6 market core integrated into `source/market`
- Security hardening work (local/test scope): AidRegistry chain enforcement, TestSaleVault pull-refund accounting, proof-backed AssetRegistry design, faucet hardening in API artifacts

**Verification highlights (local runs):**
- Solidity: AID and contracts test suites passing
- JavaScript: market, integration, and AID test suites passing
- API server tests passing
- Typecheck and build passing

See [`source/docs/STATUS.md`](source/docs/STATUS.md) for the detailed, evidence-oriented status.

## Important Limitations

- **No security audit** has been completed
- **No token economics** finalized (no supply/allocation/issuance policy)
- **No distributed/public production network** (local/test environments only)
- **No governance / upgrade / key-management production process**
- **Not for mainnet, real value, or real-money use**

## Development

### Prerequisites

- Node.js and `pnpm`
- Foundry (`forge`, `cast`, `anvil`) for Solidity workflows
- Go/toolchain as required for local chain binaries/scripts (environment-specific)

### Common Commands

```bash
# Install dependencies
pnpm install

# Typecheck and build (workspace)
pnpm run typecheck
pnpm run build

# Market core tests
node --test source/market/test/*.test.mjs

# AID tests
node --test source/aid/test/*.test.mjs

# Solidity tests (from respective package directories)
# forge test
```

> Some chain/local-node workflows depend on environment-specific binaries and scripts under `source/ci/` and `source/chain/`.

## Security

This repository is a development/testnet workspace and has **not** undergone an independent security audit. Do not use in production or with real assets.

If you discover a security issue, please report it privately to the maintainers before public disclosure.

## Contributing

Contributions should prioritize correctness, reproducibility, and explicit documentation of limitations. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

No root license file is currently declared for this workspace. Component licenses may apply within subdirectories and third-party dependencies.
