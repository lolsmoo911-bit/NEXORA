// UNSAFE DRAFT - DO NOT RUN. This script passed private key via CLI args (--private-key).
// Preserved for reference only. Use script/DeployAid.s.sol + forge script with DEPLOYER_PRIVATE_KEY env (vm.envUint), no key CLI args.

#!/usr/bin/env node
// Deploy corrected workbench AidRegistry + AidFactory to isolated loopback local testnet.
// TESTNET ONLY. Uses existing keyring-test key (dev0) via evmd unsafe-export-eth-key;
// key material is never printed. No public RPC. No canonical tracked source modified.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WB = path.join(ROOT, 'workbench');
const EVMD = path.join(WB, 'toolchain', 'bin', 'evmd.exe');
const FORGE = path.join(WB, 'toolchain', 'foundry', 'bin-content', 'forge.exe');
const CAST = path.join(WB, 'toolchain', 'foundry', 'bin-content', 'cast.exe');
const HOME = path.join(WB, 'local-testnet', 'home');
const RPC = 'http://127.0.0.1:8545';
const CHAIN = '902024';
const PROJ = path.join(WB, 'aid-deploy');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}
function runJson(cmd, args, opts = {}) {
  return JSON.parse(run(cmd, args, opts));
}
function rpc(method, params = []) {
  return runJson(CAST, ['rpc', method, JSON.stringify(params), '--rpc-url', RPC]);
}

const pkRaw = run(EVMD, ['keys', 'unsafe-export-eth-key', 'dev0', '--keyring-backend', 'test', '--home', HOME]);
const KEY = '0x' + pkRaw.replace(/^0x/i, '').toLowerCase();
// Do not print KEY.

const obs = {
  timestamp: new Date().toISOString(),
  rpc: RPC,
  chainIdExpected: 902024,
  deployer: null,
  preflight: {},
  deployments: {},
  interactions: {},
  notes: [
    'TESTNET ONLY, isolated loopback local testnet, workbench artifacts only.',
    'Canonical aid/src/AidRegistry.sol was NOT deployed due to SPEC §4.1 chainId trust issue.',
    'Deployed workbench/aid-deploy/src/AidRegistry.sol (corrected: block.chainid, configured 902024, no caller chainId).',
    'AidFactory copied unchanged from canonical; no chainId/admin/pause semantics.',
    'aid/SPEC.md remains DRAFT: independent Solidity cross-check of all vectors and §10 decisions open. Not audited.',
  ],
};

obs.preflight.eth_chainId = rpc('eth_chainId');
obs.preflight.net_version = rpc('net_version');
const b0 = BigInt(rpc('eth_blockNumber'));
await new Promise(r => setTimeout(r, 2500));
const b1 = BigInt(rpc('eth_blockNumber'));
obs.preflight.block_t0 = '0x' + b0.toString(16);
obs.preflight.block_t1 = '0x' + b1.toString(16);
obs.preflight.advancing = b1 > b0;
if (obs.preflight.eth_chainId !== '0xdc388' || !obs.preflight.advancing) {
  throw new Error('preflight failed: ' + JSON.stringify(obs.preflight));
}

obs.deployer = run(CAST, ['wallet', 'address', '--private-key', KEY]);

function deploy(contractPath) {
  let out;
  try {
    out = execFileSync(FORGE, ['create', contractPath, '--rpc-url', RPC, '--private-key', KEY, '--broadcast', '--json'], {
      cwd: PROJ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    const msg = String(e.stdout || '') + '\n' + String(e.stderr || '');
    // retry legacy
    out = execFileSync(FORGE, ['create', contractPath, '--rpc-url', RPC, '--private-key', KEY, '--broadcast', '--legacy', '--json'], {
      cwd: PROJ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  // forge --json may emit lines; take last JSON object
  const lines = out.split(/\r?\n/).filter(Boolean);
  let j = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try { j = JSON.parse(lines[i]); if (j && (j.deployedTo || j.contractAddress)) break; } catch {}
  }
  if (!j) {
    const m = out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/);
    const tx = out.match(/Transaction hash:\s*(0x[0-9a-fA-F]{64})/);
    j = { deployedTo: m?.[1], transactionHash: tx?.[1], raw: out };
  }
  const addr = j.deployedTo || j.contractAddress;
  const txh = j.transactionHash || j.txHash;
  if (!addr || !txh) throw new Error('deploy parse failed: ' + out.slice(0, 500));
  const receipt = rpc('eth_getTransactionReceipt', [txh]);
  const code = rpc('eth_getCode', [addr, 'latest']);
  const codeHash = '0x' + createHash('sha256').update(code).digest('hex');
  return {
    address: addr,
    txHash: txh,
    blockNumber: receipt?.blockNumber,
    gasUsed: receipt?.gasUsed,
    effectiveGasPrice: receipt?.effectiveGasPrice,
    status: receipt?.status,
    deployedBytecodeLen: (code.length - 2) / 2,
    deployedBytecodeSha256: codeHash,
  };
}

obs.deployments.AidFactory = deploy('src/AidFactory.sol:AidFactory');
obs.deployments.AidRegistry = deploy('src/AidRegistry.sol:AidRegistry');

const factory = obs.deployments.AidFactory.address;
const registry = obs.deployments.AidRegistry.address;

// Read-only checks
obs.interactions.registryConfiguredChainId = run(CAST, ['call', registry, 'configuredChainId()(uint256)', '--rpc-url', RPC]);
obs.interactions.registryTotalBefore = run(CAST, ['call', registry, 'totalRegistrations()(uint256)', '--rpc-url', RPC]);
obs.interactions.registryIsRegisteredZero = run(CAST, ['call', registry, 'isRegistered(bytes32)(bool)', '0x' + '00'.repeat(32), '--rpc-url', RPC]);

// Factory predict/deploy path: deploy a Marker-like tiny contract? Use AidFactory's own behavior with simple init code.
// init code for a contract that returns empty runtime: 60006000fd? No, constructor reverts. Use minimal deployable: 600a600c600039600a6000f3602a60005260206000f3 (returns 42)
const initCode = '0x600a600c600039600a6000f3602a60005260206000f3';
const initHash = run(CAST, ['keccak', initCode]);
const assetId = '0x' + '11'.repeat(32);
const salt = run(CAST, ['call', factory, 'saltFor(bytes32,bytes32)(bytes32)', assetId, initHash, '--rpc-url', RPC]);
const predicted = run(CAST, ['call', factory, 'predict(bytes32,bytes32)(address)', salt, initHash, '--rpc-url', RPC]);
obs.interactions.factory = { initCode, initHash, assetId, salt, predicted };

// deploy via factory
let factOut;
try {
  factOut = run(CAST, ['send', factory, 'deploy(bytes32,bytes)', salt, initCode, '--rpc-url', RPC, '--private-key', KEY, '--json']);
} catch (e) {
  factOut = run(CAST, ['send', factory, 'deploy(bytes32,bytes)', salt, initCode, '--rpc-url', RPC, '--private-key', KEY, '--legacy', '--json']);
}
obs.interactions.factory.deployTx = JSON.parse(factOut);
const deployedCode = rpc('eth_getCode', [predicted, 'latest']);
obs.interactions.factory.deployedCodeAtPredicted = deployedCode;
obs.interactions.factory.deployedRuntimeSha256 = '0x' + createHash('sha256').update(deployedCode).digest('hex');
obs.interactions.factory.isDeployed = run(CAST, ['call', factory, 'isDeployed(bytes32,bytes32)(bool)', salt, initHash, '--rpc-url', RPC]);

// revert case: second deploy same salt
let revertOk = false;
try {
  run(CAST, ['send', factory, 'deploy(bytes32,bytes)', salt, initCode, '--rpc-url', RPC, '--private-key', KEY]);
} catch (e) {
  revertOk = true;
  obs.interactions.factory.secondDeployReverted = true;
  obs.interactions.factory.secondDeployError = String(e.stderr || e.message || e).slice(0, 400);
}
if (!revertOk) obs.interactions.factory.secondDeployReverted = false;

// Registry register path: compute nativeId on chain 902024 using Aid logic via a small helper? Easier: use cast to compute with the library is hard; compute off-chain using keccak.
// native: keccak256(0xa1 || domainSeparator(902024,1) || 0x00 || bytes32(0))
function u256(n) { return BigInt(n).toString(16).padStart(64, '0'); }
const domain = run(CAST, ['keccak', '0x' + u256(902024) + u256(1)]).toLowerCase();
const nativeId = run(CAST, ['keccak', '0xa1' + domain.slice(2) + '00' + '00'.repeat(32)]).toLowerCase();
obs.interactions.registry.nativeDomain = domain;
obs.interactions.registry.nativeAssetId = nativeId;
let regOut;
try {
  regOut = run(CAST, ['send', registry, 'register(bytes32,uint8,bytes32)', nativeId, '0', '0x' + '00'.repeat(32), '--rpc-url', RPC, '--private-key', KEY, '--json']);
} catch (e) {
  regOut = run(CAST, ['send', registry, 'register(bytes32,uint8,bytes32)', nativeId, '0', '0x' + '00'.repeat(32), '--rpc-url', RPC, '--private-key', KEY, '--legacy', '--json']);
}
obs.interactions.registry.registerNativeTx = JSON.parse(regOut);
obs.interactions.registry.isRegisteredNative = run(CAST, ['call', registry, 'isRegistered(bytes32)(bool)', nativeId, '--rpc-url', RPC]);
obs.interactions.registry.verifyNative = run(CAST, ['call', registry, 'verify(bytes32,bytes32)(bool)', nativeId, '0x' + '00'.repeat(32), '--rpc-url', RPC]);
obs.interactions.registry.totalAfter = run(CAST, ['call', registry, 'totalRegistrations()(uint256)', '--rpc-url', RPC]);

// Registry revert case: wrong metadata
let badOk = false;
try {
  run(CAST, ['send', registry, 'register(bytes32,uint8,bytes32)', nativeId, '1', '0x' + '00'.repeat(32), '--rpc-url', RPC, '--private-key', KEY]);
} catch (e) { badOk = true; obs.interactions.registry.wrongMetadataReverted = true; }
obs.interactions.registry.wrongMetadataReverted = badOk;
// already registered revert
badOk = false;
try {
  run(CAST, ['send', registry, 'register(bytes32,uint8,bytes32)', nativeId, '0', '0x' + '00'.repeat(32), '--rpc-url', RPC, '--private-key', KEY]);
} catch (e) { badOk = true; obs.interactions.registry.duplicateReverted = true; }
obs.interactions.registry.duplicateReverted = badOk;

// Pause/access-control/admin semantics: no such functions exist (by design). Document via ABI absence checks.
function abiHas(addr, sig) {
  try { run(CAST, ['call', addr, sig, '--rpc-url', RPC]); return { callable: true }; }
  catch (e) { const s = String(e.stderr||e.message||''); return { callable: false, error: s.slice(0,120) }; }
}
obs.interactions.adminSemantics = {
  registryOwner: abiHas(registry, 'owner()(address)'),
  registryPause: abiHas(registry, 'paused()(bool)'),
  factoryOwner: abiHas(factory, 'owner()(address)'),
  note: 'AidRegistry/AidFactory have no owner, no upgrade path, no pause by design (Phase 8 governance absent). Calls expected to fail/revert as nonexistent selectors or empty behavior.'
};

obs.success = obs.deployments.AidFactory.status === '0x1' &&
  obs.deployments.AidRegistry.status === '0x1' &&
  obs.interactions.registryConfiguredChainId.includes('902024') &&
  obs.interactions.factory.isDeployed.includes('true') &&
  obs.interactions.factory.secondDeployReverted === true &&
  obs.interactions.registry.isRegisteredNative.includes('true') &&
  obs.interactions.registry.verifyNative.includes('true');

const outPath = path.join(PROJ, 'observations-2026-11-07.json');
fs.writeFileSync(outPath, JSON.stringify(obs, null, 2));
console.log(JSON.stringify({ success: obs.success, deployer: obs.deployer, registry: registry, factory: factory, observations: outPath }, null, 2));
if (!obs.success) process.exit(1);
