# ci/ — Phase 1 verification manually re-runnable

- `verify-reference-chain.sh` — starts the unmodified upstream node, verifies
  JSON-RPC, deploys contracts/src/NexoraGreeter.sol, writes transcripts to
  `ci-artifacts/`.

Local run requirements (per `docs/phase1-environment.md`): Linux, Go 1.25.9,
make, gcc, jq, foundry (forge/cast), and `cosmos/evm` v0.7.3 checked out to
`/tmp/cosmos-evm` with `evmd` built and on `PATH`:

```bash
git clone --depth 1 --branch v0.7.3 https://github.com/cosmos/evm.git /tmp/cosmos-evm
cd /tmp/cosmos-evm
make install
export PATH="$(go env GOPATH)/bin:$PATH"
cd <this NEXORA repo>
CHAIN_ID=cosmos_262144-1 bash ci/verify-reference-chain.sh
```