/**
 * EVM/RPC compatibility matrix (Phase 6).
 *
 * Each row is derived from canonical evidence in this repo (ci/verify-reference-chain.sh,
 * ci/phase2/verify.sh, ci/phase3/run-4validators.sh, chain/nexora-devnet.json).
 * "expected" is what the canonical scripts assert. "evidence" records WHERE to look.
 * Live "observed" values are filled by probe.mjs ONLY when a loopback node answers;
 * a mocked/CI claim is never presented as a local observation.
 *
 * status vocabulary:
 *   CI-VERIFIED  = asserted by canonical GitHub Actions runs (Phases 1-3).
 *   LOCAL-LIVE   = observed against the workbench local-testnet node in this session.
 *   NOT-RUN      = not exercised in this session (no live node or no toolchain).
 */
export const EXPECTED_EVM_CHAIN_ID_DEC = 902024;
export const EXPECTED_EVM_CHAIN_ID_HEX = '0xdc388';
export const EXPECTED_COSMOS_CHAIN_ID = 'eip155:902024';
export const EXPECTED_REFERENCE_HEX = '0x40000'; // upstream 262144, must NOT appear

export const MATRIX = [
  {
    method: 'eth_chainId (NEXORA devnet)',
    expected: '0xdc388 (902024)',
    evidence: 'chain/nexora-devnet.json evm_chain_id; ci/phase2/verify.sh asserts; Phase 2 run #38071169448',
    status: 'CI-VERIFIED',
    observed: null,
  },
  {
    method: 'net_version (NEXORA devnet)',
    expected: '"902024"',
    evidence: 'ci/phase2/verify.sh asserts net_version == evm_chain_id',
    status: 'CI-VERIFIED',
    observed: null,
  },
  {
    method: 'eth_chainId (upstream reference)',
    expected: '0x40000 (262144) — reference value, must be absent on NEXORA',
    evidence: 'ci/verify-reference-chain.sh EXPECTED_EVM_CHAIN_ID; Phase 1 run #38016004413',
    status: 'CI-VERIFIED',
    observed: null,
  },
  {
    method: 'eth_blockNumber advancing',
    expected: 'strictly increasing across reads (blocks produced)',
    evidence: 'ci/verify-reference-chain.sh + ci/phase2/verify.sh sample twice; Phase 3: 4/4 agree at height 3',
    status: 'CI-VERIFIED',
    observed: null,
  },
  {
    method: 'web3_clientVersion',
    expected: 'non-empty string',
    evidence: 'ci/verify-reference-chain.sh queries web3_clientVersion',
    status: 'CI-VERIFIED',
    observed: null,
  },
  {
    method: 'eth_gasPrice',
    expected: 'non-zero hex, ~1-2 gwei (feemarket floor 1 gwei)',
    evidence: 'chain/nexora-devnet.json fees; docs/STATUS.md observed 0x430e2340 (~1.1 gwei)',
    status: 'CI-VERIFIED',
    observed: null,
  },
  {
    method: 'eth_getBalance (EVM view of genesis account)',
    expected: 'non-zero for funded dev accounts',
    evidence: 'ci/verify-reference-chain.sh + ci/phase2/verify.sh query eth_getBalance',
    status: 'CI-VERIFIED',
    observed: null,
  },
  {
    method: 'Cosmos bank transfer settles (anex)',
    expected: 'tx code 0, balances move exactly',
    evidence: 'ci/phase2/verify.sh bank send + evmd q tx code==0; Phase 2/3 CI',
    status: 'CI-VERIFIED',
    observed: null,
  },
  {
    method: 'EVM transfer settles (wei)',
    expected: 'settles exactly',
    evidence: 'ci/phase2/verify.sh EVM transfer leg',
    status: 'CI-VERIFIED',
    observed: null,
  },
  {
    method: 'Solidity deploy + greet() == "Hello NEXORA"',
    expected: 'deploy receipt 0x1, greet() returns "Hello NEXORA"',
    evidence: 'ci/verify-reference-chain.sh (NexoraGreeter) + ci/phase2/verify.sh; Phase 1/2 CI',
    status: 'CI-VERIFIED',
    observed: null,
  },
  {
    method: 'eth_estimateGas',
    expected: 'returns a gas number for a simple transfer',
    evidence: 'EVM standard; must be exercised against the local node (probe.mjs). No canonical transcript in repo.',
    status: 'NOT-RUN',
    observed: null,
  },
  {
    method: 'Phase 5 contracts (AIdRegistry/AidFactory) on NEXORA chain',
    expected: 'deploy + calls succeed on the live NEXORA devnet',
    evidence: 'docs/phase5-report.md section 7: explicitly NOT done on the NEXORA chain (Foundry EVM only).',
    status: 'NOT-RUN',
    observed: null,
  },
];

/** Matrix summary counts (deterministic, for reports/tests). */
export function matrixSummary(rows = MATRIX) {
  const by = {};
  for (const r of rows) by[r.status] = (by[r.status] || 0) + 1;
  return { total: rows.length, ...by };
}

/** Assert matrix invariants: every row has method/expected/evidence/status. */
export function validateMatrix(rows = MATRIX) {
  if (!Array.isArray(rows) || rows.length === 0) throw new TypeError('matrix must be a non-empty array');
  for (const r of rows) {
    for (const k of ['method', 'expected', 'evidence', 'status']) {
      if (typeof r[k] !== 'string' || r[k].length === 0) {
        throw new TypeError(`matrix row missing "${k}": ${JSON.stringify(r)}`);
      }
    }
    if (!['CI-VERIFIED', 'LOCAL-LIVE', 'NOT-RUN'].includes(r.status)) {
      throw new RangeError(`unknown matrix status: ${r.status}`);
    }
  }
  return true;
}
