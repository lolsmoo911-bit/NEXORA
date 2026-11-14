#!/usr/bin/env node
/**
 * Custorium exchange — redeploy on-chain contracts against a RUNNING chain.
 *
 * Use case: the chain data was reset (fresh genesis, same keys) but the contracts
 * that lived in the old blocks are gone. bootstrap.mjs --force would re-init the
 * whole chain home (destructive, needs the node down) — this script instead deploys
 * the 4 AssetToken contracts + MockOracle against the running RPC, re-seeds balances
 * and oracle prices, and updates the chain-state file in place (keys preserved).
 *
 * Usage:  node source/nexora-exchange/chain/redeploy-contracts.mjs
 * State:  /tmp/opencode/demo-chain-state.json (backup written next to it first)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const FOUNDRY = path.join(ROOT, '.foundry/versions/foundry-rs/foundry/v1.8.5');
const FORGE = path.join(FOUNDRY, 'forge');
const CAST = path.join(FOUNDRY, 'cast');
const CONTRACTS_DIR = path.join(ROOT, 'source/contracts');
const RPC = 'http://127.0.0.1:8545';
const STATE = process.env.CHAIN_STATE || '/tmp/opencode/demo-chain-state.json';
// Chain gas price: the Custorium devnet (denom csto) enforces minimum-gas-prices
// 0.0001csto (1e14 wei) — default to 2x so txs are accepted.
const GAS_PRICE_FLAG = process.env.CHAIN_GAS_PRICE || '200000000000000';
const EVM_CHAIN_ID_HEX = '0xdc388';

const TOKENS = [
  { symbol: 'nUSD', name: 'Custorium USD', assetClass: 'fiat', instrument: null },
  { symbol: 'nXAU', name: 'Custorium Gold', assetClass: 'metal', instrument: 'XAUUSD' },
  { symbol: 'nBTC', name: 'Custorium Bitcoin', assetClass: 'crypto', instrument: 'BTCUSD' },
  { symbol: 'nEUR', name: 'Custorium Euro', assetClass: 'fiat', instrument: 'EURUSD' },
];
const SEED_PRICES = {
  XAUUSD: { price: 2350e8, decimals: 8 },
  BTCUSD: { price: 65000e8, decimals: 8 },
  EURUSD: { price: 1.08e8, decimals: 8 },
};

const log = (...a) => console.log('[redeploy]', ...a);
const fail = (m) => { console.error('[redeploy] FATAL:', m); process.exit(1); };

function run(cmd, args, opts = {}) {
  const p = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (p.status !== 0) {
    throw new Error(`${path.basename(cmd)} ${args.slice(0, 4).join(' ')} exit=${p.status}\nSTDOUT:${(p.stdout || '').slice(-400)}\nSTDERR:${(p.stderr || '').slice(-800)}`);
  }
  return (p.stdout || '').trim();
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

function keccak32(text) {
  return run(CAST, ['keccak', text]).replace(/^0x/, '').padStart(64, '0');
}

const WEI18 = 10n ** 18n;

if (!fs.existsSync(STATE)) fail(`chain state missing (${STATE}) — run bootstrap.mjs first`);
const chain = JSON.parse(fs.readFileSync(STATE, 'utf8'));

const id = await rpc('eth_chainId');
if (id?.result !== EVM_CHAIN_ID_HEX) fail(`chain id mismatch: got ${id?.result}, expected ${EVM_CHAIN_ID_HEX} — is the right chain running?`);
log(`chain up (${EVM_CHAIN_ID_HEX}) — deploying against the RUNNING node (home dir untouched)`);

/**
 * Admin/gas account — same policy as the exchange server: the distribution plan
 * designates treasury w05 (unfrozen, funded with native CSTO) as deployer/admin.
 * Resolution: CUSTORIUM_ADMIN_PK env > /tmp/opencode/custorium-admin-pk file >
 * w05 from the plan's test keyring > legacy dev0.
 */
function resolveAdmin() {
  const pkFrom = (pk) => pk && (/^(0x)?[0-9a-fA-F]{64}$/.test(pk.trim()) ? { pk: pk.trim().startsWith('0x') ? pk.trim() : '0x' + pk.trim() } : null);
  let admin = null;
  if (process.env.CUSTORIUM_ADMIN_PK) admin = pkFrom(process.env.CUSTORIUM_ADMIN_PK);
  if (!admin) {
    try { admin = pkFrom(fs.readFileSync('/tmp/opencode/custorium-admin-pk', 'utf8')); } catch { /* absent */ }
  }
  if (!admin) {
    try {
      const EVMD = path.join(ROOT, 'nexora-chain/cosmos-evm/build/evmd');
      const out = spawnSync(EVMD, ['keys', 'unsafe-export-eth-key', 'w05', '--keyring-backend', 'test', '--home', path.join(ROOT, 'nexora-plan/keys')], { encoding: 'utf8', timeout: 15_000 });
      admin = pkFrom(out.stdout);
    } catch { /* plan keyring not available */ }
  }
  if (!admin) admin = { pk: chain.accounts.admin?.pk || chain.accounts.dev0.pk };
  admin.evmAddress = run(CAST, ['wallet', 'address', '--private-key', admin.pk]);
  return admin;
}

const admin = resolveAdmin();
log(`admin/deployer: ${admin.evmAddress}`);
const castEnv = { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH || ''}` };
const send = (args) => run(CAST, [...args, '--rpc-url', RPC, '--private-key', admin.pk, '--gas-price', GAS_PRICE_FLAG, '--gas-limit', process.env.CHAIN_GAS_LIMIT || '600000'], { env: castEnv.env });

log('compiling contracts (forge)…');
run(FORGE, ['build', '--root', CONTRACTS_DIR], { env: castEnv });

// skip if every contract already has code at the recorded addresses
const code = async (addr) => (await rpc('eth_getCode', [addr, 'latest']))?.result ?? '0x';
{
  let anyMissing = false;
  for (const t of TOKENS) {
    const a = chain.tokens[t.symbol]?.address;
    if (!a || (await code(a)) === '0x') { anyMissing = true; break; }
  }
  if (!anyMissing && chain.oracle?.address && (await code(chain.oracle.address)) !== '0x') {
    log('all contracts already have code — nothing to do');
    process.exit(0);
  }
}

fs.copyFileSync(STATE, STATE + '.bak');
log(`state backup: ${STATE}.bak`);

const contracts = {};
for (const t of TOKENS) {
  const aid = '0x' + keccak32(`custorium:aid:${t.symbol.toLowerCase()}`);
  const assetClass = '0x' + keccak32(t.assetClass);
  const out = run(FORGE, [
    'create', 'src/AssetToken.sol:AssetToken',
    '--root', CONTRACTS_DIR, '--rpc-url', RPC, '--private-key', admin.pk,
    '--gas-price', GAS_PRICE_FLAG, '--broadcast',
    '--constructor-args', t.name, t.symbol, '18', aid, assetClass, `custorium://demo/${t.symbol.toLowerCase()}`, admin.evmAddress,
  ], { env: castEnv });
  const m = out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/) || out.match(/Address:\s*(0x[0-9a-fA-F]{40})/);
  if (!m) fail(`no address in forge create output:\n${out.slice(-600)}`);
  contracts[t.symbol] = { name: t.name, symbol: t.symbol, address: m[1], instrument: t.instrument, decimals: 18, assetClass: t.assetClass };
  log(`  ${t.symbol} -> ${m[1]}`);
}
{
  const out = run(FORGE, [
    'create', 'src/MockOracle.sol:MockOracle',
    '--root', CONTRACTS_DIR, '--rpc-url', RPC, '--private-key', admin.pk,
    '--gas-price', GAS_PRICE_FLAG, '--broadcast',
    '--constructor-args', admin.evmAddress, '300',
  ], { env: castEnv });
  const m = out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/) || out.match(/Address:\s*(0x[0-9a-fA-F]{40})/);
  if (!m) fail(`no address in forge create output:\n${out.slice(-600)}`);
  contracts.oracle = { address: m[1], maxStaleness: 300 };
  log(`  oracle -> ${m[1]}`);
}

log('seeding balances (real mint txs)');
const mints = [
  ['nUSD', chain.accounts.alice.evmAddress, 100000n * WEI18],
  ['nUSD', chain.accounts.bob.evmAddress, 100000n * WEI18],
  ['nUSD', chain.accounts.mm.evmAddress, 500000n * WEI18],
  ['nXAU', chain.accounts.mm.evmAddress, 500n * WEI18],
  ['nBTC', chain.accounts.mm.evmAddress, 2n * WEI18],
  ['nEUR', chain.accounts.mm.evmAddress, 50000n * WEI18],
];
for (const [sym, to, amount] of mints) {
  const tx = send(['send', contracts[sym].address, 'mint(address,uint256)', to, amount.toString(), '--json']);
  let h = '?';
  try { h = JSON.parse(tx).transactionHash || '?'; } catch {}
  log(`  mint ${sym} ${Number(amount / WEI18)} -> ${to.slice(0, 10)}… tx=${h.slice(0, 18)}…`);
}

log('pushing seed prices to on-chain oracle');
for (const [instrument, p] of Object.entries(SEED_PRICES)) {
  const assetKey = '0x' + keccak32(instrument);
  send(['send', contracts.oracle.address, 'pushPrice(bytes32,uint256,uint8,bytes32)',
    assetKey, String(p.price), String(p.decimals), '0x' + '0'.repeat(64), '--json']);
  log(`  oracle ${instrument} = ${p.price / 1e8}`);
}

// sanity: verify the mints actually landed (a codeless-address transfer "succeeds" as a no-op)
for (const [sym, to, amount] of mints) {
  const bal = await rpc('eth_call', [{ to: contracts[sym].address, data: '0x70a08231' + to.replace(/^0x/, '').padStart(64, '0') }, 'latest']);
  const got = bal?.result && bal.result !== '0x' ? BigInt(bal.result) : 0n;
  if (got < amount) fail(`mint verification failed for ${sym} (balance ${got} < ${amount}) — contract has no code?`);
}
log('mint verification OK (balances read back from chain)');

chain.tokens = Object.fromEntries(TOKENS.map(t => [t.symbol, contracts[t.symbol]]));
chain.oracle = contracts.oracle;
chain.accounts.admin = { name: 'w05', role: 'exchange admin/deployer (per distribution plan)', evmAddress: admin.evmAddress };
chain.nativeToken = chain.nativeToken && chain.nativeToken.denom === 'csto' ? chain.nativeToken : { denom: 'csto', symbol: 'CSTO', decimals: 18 };
chain.redeployedAt = new Date().toISOString();
fs.writeFileSync(STATE, JSON.stringify(chain, null, 2) + '\n');
log(`state updated: ${STATE} (tokens + oracle addresses)`);
log('next: wipe the exchange state file if it predates this redeploy, then restart the exchange server.');
