# EVM/RPC compatibility + gas (Phase 6 workbench)

Status: isolated workbench. No tracked source touched. No commit/push to main.

## What this is

- `src/matrix.mjs` — RPC compatibility matrix. Every row states `expected`
  (from canonical `ci/verify-reference-chain.sh`, `ci/phase2/verify.sh`,
  `ci/phase3/run-4validators.sh`, `chain/nexora-devnet.json`), `evidence`
  (where to look), and `status`: `CI-VERIFIED` (GitHub Actions Phases 1–3),
  `LOCAL-LIVE` (observed against the workbench local-testnet node in this
  session), or `NOT-RUN` (not exercised here). Mocked/CI facts are never
  presented as local observations.
- `src/gas.mjs` — pure BigInt gas accounting: `txFeeWei`, `clearsBaseFee`,
  `estimateBudgetWei`, anex/wei conversions. Constants mirror
  `chain/nexora-devnet.json`: 1 gwei floor, 2 gwei configured. No floats.
- `src/probe.mjs` — live loopback probe (`probeNode`) returning
  `connected:false` when nothing answers; never fabricates chain data.
- `scripts/probe.mjs` — CLI for live observations.

## Run

```
cd workbench/evm-compat && node --test test/*.test.mjs
node scripts/probe.mjs            # against http://127.0.0.1:8545
```

## Local testnet (separate session path)

Deterministic genesis + single-validator devnet live under
`workbench/local-testnet/` (own home, own disk state, test-only). Nothing
there reads or writes `testnet/state.json` / `testnet/ledger.json`.

## Scope limits

- Single-validator local devnet only (no 4-validator consensus claim;
  Phase 3 consensus remains CI-VERIFIED).
- `eth_estimateGas` + Phase 5 contracts on the live chain are probed where
  possible and recorded as NOT-RUN until they succeed.
- No public RPC, no tunnel, no Cloudflare changes. Loopback binds only.
