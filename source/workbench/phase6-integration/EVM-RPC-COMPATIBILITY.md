# Phase 6 — EVM / RPC compatibility matrix (updated 2026-11-07)

Status: **PARTIALLY VERIFIED LOCALLY** (single-validator, fresh isolated loopback testnet) + **CI-VERIFIED** for Phases 1–3. Not a production/mainnet/public-RPC claim.

## Environment and provenance (confirmed)

- Pinned upstream: `cosmos/evm v0.7.3`, commit `c3ae9067a7eadcdea55a5192226916deb44c71c4` (CI-pinned). Local source staged from SHA-addressed archive (no git binary/WSL on this host).
- Required Go from CI: `1.25.9`. Portable Go extracted under `workbench/toolchain/go` (official sha256 `a7a710e2…` verified).
- **evmd built locally (Windows workaround):** `go build -tags netgo -trimpath` with `CGO_ENABLED=1`, `CC=zig-cc.cmd` (zig 0.17.1 clang), output `workbench/toolchain/bin/evmd.exe` sha256 `90c2244aaed95e0fde8fae0abfeeb93ff2bcb7e5fa288f4fa7bbcb641a94226e`. This is **not** the canonical Linux CI build path.
- WSL unusable from LocalSystem (`WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`); Windows DNS for `localhost` failed on this host — genesis/config patched to bind loopback by IP (`127.0.0.1`) in workbench homes (same parameters, host-compat only).
- Config: Cosmos `eip155:902024`, EVM 902024 (`0xdc388`), denom `anex` (18). Live `eth_chainId` independently confirmed.

## Local evidence (fresh verify, 2026-11-07)

Source: `workbench/local-testnet/verify-2026-11-07/task1-evidence.json` (status `pass`, PID-scoped cleanup, `post_stop_8545_listeners=[]`). Fresh homes `home1`/`home2` regenerated; genesis sha256 identical twice: `4938286212f9005b4b8c3194673abc13d9b1c0fa70b0515133f5391a0393abc1` (deterministic on this Windows/platform path; **differs from CI Linux artifact `a04b29aa…`** — do not claim cross-platform byte identity).

| Capability | Probe / acceptance | Local result (fresh isolated home, 127.0.0.1:8545) | Status |
|---|---|---|---|
| Chain identity | `eth_chainId==0xdc388`; `net_version==902024` | `0xdc388` / `902024` (raw envelopes captured) | **LOCAL PASS** |
| EVM block height | `eth_blockNumber` increases | `0x1` → `0x2` (advancing) | **LOCAL PASS** |
| EVM block query | `eth_getBlockByNumber(latest,false)` shape | 26 expected keys incl. `baseFeePerGas`, `gasUsed`, `hash`, `transactionsRoot`; `baseFeePerGas=0x2da282a8` | **LOCAL PASS** |
| Balance / nonce context | `eth_getBalance` for genesis dev account | dev0 `0x3635c9adc5dea00000` (1000 anex) | **LOCAL PASS** |
| Gas quote | `eth_gasPrice` | `0x3aac5ed8` (fresh active-start context) | **LOCAL PASS** (height/feemarket dependent; idle chains can decay to 0x0 — see evm-compat observations) |
| Gas estimate | `eth_estimateGas` simple transfer | `0x5dc0` (24000) | **LOCAL PASS** |
| EVM tx / receipt parity | deploy+receipt on loopback | NexoraGreeter deployed/called prior (evm-compat); AID broadcast on fresh aid-deploy home is **task 3** (separate evidence) | **PARTIAL / see task 3** |
| Cosmos status | CometBFT RPC | not re-probed in this verify run (node log shows RPC 26657 started) | **CI-VERIFIED; local untested in this run** |
| Cosmos bank tx/query | bank send, balances | not re-run locally | **CI-VERIFIED ONLY** |
| 4-validator consensus/fault/recovery | Phase 3 acceptance | not feasible on this Windows/LocalSystem host (WSL blocked) | **CI-VERIFIED ONLY** |
| JSON-RPC writes disabled at scanner | scanner guard | `workbench/nexora-scan` 11/11 (separate workbench, loopback-only) | **PASS (scanner guard only, not chain compat)** |

## CI-only / untested / gaps

- **CI-only:** Phase 3 4-validator consensus, kill/restart/re-sync, multi-node deterministic genesis; full Cosmos transfer leg locally; Linux-clean build parity.
- **Untested locally (this session):** `eth_sendRawTransaction` under load, filters/logs depth, websocket subscriptions, nonce sequencing under concurrent txs, state sync/snapshots, public RPC behavior (must remain unexposed).
- **Known behavior:** `eth_blockNumber` may return transient "invalid height / not ready" before first block commits — readiness must wait for valid block result, not only `eth_chainId`. `eth_gasPrice`/baseFee vary with feemarket state.
- **Not claimed:** mainnet readiness, production keys, security audit, public endpoint, 4-validator local proof.

## Verification protocol (repeatable, safe)

1. Fresh isolated home under `workbench/` (never `testnet/state.json` or `ledger.json`).
2. Bind all services to `127.0.0.1`. No tunnels/DNS.
3. Wait for valid `eth_blockNumber` result (handles pre-block-1 transient).
4. Record raw JSON-RPC envelopes, chainId/net_version, block advancement, gas/baseFee, estimate, balance.
5. Stop only the script-owned `evmd` PID; verify no 8545 listener remains. Do not kill unrelated `evmd` processes.
6. Never include keys/mnemonics/wallet files in evidence.
