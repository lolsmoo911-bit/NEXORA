# Phase 6 — Gas accounting measurement plan

Status: **not yet measured against a local live node**.

## Required observations

For every operation, preserve the input class, RPC method, returned estimate, receipt gasUsed (where applicable), fee parameters, chain height, and toolchain version.

| Operation | Measurement | Data source |
|---|---|---|
| Plain EVM call | `eth_estimateGas`, optional debug trace | Local testnet RPC |
| Simple native transfer | estimateGas vs receipt gasUsed | Locally signed test-only transaction |
| ERC-20 transfer | estimateGas vs receipt gasUsed | Phase 5 contract deployed locally |
| Registry write | estimateGas vs receipt gasUsed | Phase 5 AssetRegistry on local testnet |
| CREATE2 deployment | deployment tx gasUsed and code verification | Local-only CREATE2 deployer |
| EVM fee quote | `eth_gasPrice` (and `eth_feeHistory` if supported) | Local testnet RPC |
| Cosmos bank send | response gas_wanted vs gas_used | Local Cosmos RPC/gRPC |

## Rules

- Use only an isolated loopback testnet with test-only keys.
- Never submit writes to a public RPC endpoint.
- Record the exact transaction class and code hash so comparisons are reproducible.
- Keep config `min_gas_price` separate from observed gas price and from actual transaction gasUsed.
- Do not use the historical README value `0x430e2340` as a current result.
- Do not label measurements as complete until a local node and receipts have been captured.

## Result record template

| Date / commit | Node build | Operation | Estimate | Actual gasUsed | Fee quote | Height | Exit |
|---|---|---|---:|---:|---:|---:|---|

The RPC compatibility matrix is in `EVM-RPC-COMPATIBILITY.md`.
