#!/usr/bin/env node
/**
 * NEXORA demo-exchange chain bootstrap — TESTNET/DEVNET ONLY.
 *
 * Stands up the REAL local NEXORA chain (evmd devnet, chain-id eip155:902024 / EVM 902024)
 * and deploys the demo's real on-chain tokens + oracle:
 *
 *   - 4 AssetToken contracts (nUSD quote currency, nXAU/nBTC/nEUR assets)
 *   - 1 MockOracle contract for on-chain price feeds
 *
 * Everything here runs on a disposable loopback devnet (127.0.0.1 only). Keys are generated
 * locally, are TEST keys, and are never committed — they live in the state file under /tmp.
 *
 * Idempotent: if the state file exists and the RPC answers with the expected chain id,
 * this script exits without changing anything.
 *
 * Usage:  node source/demo-exchange/chain/bootstrap.mjs [--force]
 * State:  /tmp/opencode/demo-chain-state.json
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const EVMD = path.join(ROOT, 'nexora-chain/cosmos-evm/build/evmd');
const FOUNDRY = path.join(ROOT, '.foundry/versions/foundry-rs/foundry/v1.8.5');
const FORGE = path.join(FOUNDRY, 'forge');
const CAST = path.join(FOUNDRY, 'cast');
const CONTRACTS_DIR = path.join(ROOT, 'source/contracts');

const HOME = process.env.CHAIN_HOME || '/tmp/opencode/nexora-demo-home';
const RPC = 'http://127.0.0.1:8545';
const STATE = process.env.CHAIN_STATE || '/tmp/opencode/demo-chain-state.json';
const CHAIN_LOG = '/tmp/opencode/nexora-demo-chain.log';

const COSMOS_CHAIN_ID = 'eip155:902024';
const EVM_CHAIN_ID = 902024;
const EVM_CHAIN_ID_HEX = '0xdc388';
const DENOM = 'anex';
const KEYRING = 'test';
const KEYALGO = 'eth_secp256k1';

// Genesis balances (base units, 18 decimals): 1e21 = 1000 ANEX each for gas+usage.
const BALANCE = '1000000000000000000000';       // 1000 ANEX per demo account
const VALIDATOR_BALANCE = '100000000000000000000000000'; // 1e26 ANEX (validator, matches phase-2 devnet params)
const SELF_DELEGATION = '1000000000000000000000'; // 1000 ANEX self-delegation
const GAS_PRICE_FLAG = '2000000000'; // 2 gwei in base units

const ACCOUNT_NAMES = ['mykey', 'dev0', 'alice', 'bob', 'mm'];

const TOKENS = [
  { symbol: 'nUSD', name: 'NEXORA USD', assetClass: 'fiat', instrument: null },
  { symbol: 'nXAU', name: 'NEXORA Gold', assetClass: 'metal', instrument: 'XAUUSD' },
  { symbol: 'nBTC', name: 'NEXORA Bitcoin', assetClass: 'crypto', instrument: 'BTCUSD' },
  { symbol: 'nEUR', name: 'NEXORA Euro', assetClass: 'fiat', instrument: 'EURUSD' },
];

const SEED_PRICES = {
  XAUUSD: { price: 2350e8, decimals: 8 },
  BTCUSD: { price: 65000e8, decimals: 8 },
  EURUSD: { price: 1.08e8, decimals: 8 }, // 1.08 with 8 decimals
};

const log = (...a) => console.log('[bootstrap]', ...a);
const fail = (m) => { console.error('[bootstrap] FATAL:', m); process.exit(1); };

function run(cmd, args, opts = {}) {
  const p = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (p.status !== 0) {
    throw new Error(`${path.basename(cmd)} ${args.slice(0, 4).join(' ')} exit=${p.status}\nSTDOUT:${(p.stdout || '').slice(-400)}\nSTDERR:${(p.stderr || '').slice(-800)}`);
  }
  return (p.stdout || '').trim();
}

function evmd(args, opts) { return run(EVMD, args, opts); }

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

function keccak32(text) {
  // cast keccak gives 32-byte keccak-256 of the input string
  return run(CAST, ['keccak', text]).replace(/^0x/, '').padStart(64, '0');
}

const WEI18 = 10n ** 18n;
function toWei18(n) {
  const s = typeof n === 'bigint' ? n.toString() : Number(n).toFixed(18);
  const [i, f = ''] = s.split('.');
  const frac = (f || '').slice(0, 18).padEnd(18, '0').replace(/\.+$/, '');
  return BigInt((i === '-0' ? '0' : i).replace('.', '') + frac);
}

async function main() {
  const force = process.argv.includes('--force');
  if (!fs.existsSync(EVMD)) fail(`evmd binary not found: ${EVMD}`);
  if (!fs.existsSync(CAST) || !fs.existsSync(FORGE)) fail(`foundry binaries not found in ${FOUNDRY}`);

  // ---------- idempotency ----------
  if (fs.existsSync(STATE) && !force) {
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    try {
      const id = await rpc('eth_chainId');
      if (id?.result === EVM_CHAIN_ID_HEX) {
        log(`state + chain already up (chainId ${EVM_CHAIN_ID_HEX}) — nothing to do`);
        log(`state: ${STATE}`);
        return;
      }
    } catch { /* chain down: re-provision below */ }
  }

  // ---------- port check ----------
  let rpcJson = null;
  try { rpcJson = await rpc('eth_chainId'); } catch { /* not running */ }
  if (rpcJson && rpcJson.result && rpcJson.result !== EVM_CHAIN_ID_HEX) {
    fail(`something else is already listening on ${RPC} with chainId ${rpcJson.result}`);
  }

  if (force) {
    try { fs.unlinkSync(STATE); } catch {}
  }

  // ---------- keys + genesis ----------
  if (fs.existsSync(HOME)) {
    log(`removing stale chain home ${HOME}`);
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  const env = { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH || ''}` };

  log('creating keys (test keys, local only)');
  const keys = {};
  for (const name of ACCOUNT_NAMES) {
    evmd(['keys', 'add', name, '--keyring-backend', KEYRING, '--algo', KEYALGO, '--home', HOME]);
    keys[name] = {};
  }
  log('initializing node home');
  evmd(['init', 'nexora-demo', '-o', '--chain-id', COSMOS_CHAIN_ID, '--home', HOME]);

  // read addresses (bech32 for cosmos ops, EVM hex for contract calls)
  for (const name of ACCOUNT_NAMES) {
    keys[name].address = evmd(['keys', 'show', name, '-a', '--keyring-backend', KEYRING, '--home', HOME]);
    keys[name].pk = evmd(['keys', 'unsafe-export-eth-key', name, '--keyring-backend', KEYRING, '--home', HOME]);
    if (!keys[name].pk.startsWith('0x')) keys[name].pk = '0x' + keys[name].pk;
    keys[name].evmAddress = run(CAST, ['wallet', 'address', '--private-key', keys[name].pk], { env });
  }

  const genesisPath = path.join(HOME, 'config/genesis.json');
  const genesis = JSON.parse(fs.readFileSync(genesisPath, 'utf8'));
  const fixDenoms = (o) => {
    if (Array.isArray(o)) return o.map(fixDenoms);
    if (o && typeof o === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(o)) {
        out[k] = (k === 'denom' && typeof v === 'string') ? DENOM : fixDenoms(v);
      }
      return out;
    }
    return o;
  };
  genesis.app_state.staking.params.bond_denom = DENOM;
  genesis.app_state.mint.params.mint_denom = DENOM;
  genesis.app_state.evm.params.evm_denom = DENOM;
  genesis.app_state = fixDenoms(genesis.app_state);
  genesis.consensus.params.block.max_gas = '10000000';
  genesis.app_state.bank.denom_metadata = [{
    description: 'The native NEXORA devnet token (anex).',
    denom_units: [{ denom: DENOM, exponent: 0, aliases: [] }, { denom: 'nex', exponent: 18, aliases: [] }],
    base: DENOM, display: 'nex', name: 'Nexora', symbol: 'ANEX', uri: '', uri_hash: '',
  }];
  genesis.app_state.erc20.native_precompiles = ['0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'];
  genesis.app_state.erc20.token_pairs = [{
    contract_owner: 1,
    erc20_address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    denom: DENOM,
    enabled: true,
  }];
  fs.writeFileSync(genesisPath, JSON.stringify(genesis, null, 2) + '\n');

  log('adding genesis accounts');
  evmd(['genesis', 'add-genesis-account', 'mykey', `${VALIDATOR_BALANCE}${DENOM}`, '--keyring-backend', KEYRING, '--home', HOME]);
  for (const name of ['dev0', 'alice', 'bob', 'mm']) {
    evmd(['genesis', 'add-genesis-account', name, `${BALANCE}${DENOM}`, '--keyring-backend', KEYRING, '--home', HOME]);
  }

  log('creating validator gentx + collecting');
  evmd(['genesis', 'gentx', 'mykey', SELF_DELEGATION + DENOM,
    '--gas-prices', `${GAS_PRICE_FLAG}${DENOM}`,
    '--keyring-backend', KEYRING,
    '--chain-id', COSMOS_CHAIN_ID,
    '--home', HOME,
    '--node-id', 'nexorademo',
    '--ip', '127.0.0.1',
    '--moniker', 'nexora-demo']);
  evmd(['genesis', 'collect-gentxs', '--home', HOME]);

  // ---------- config patches (loopback + json-rpc) ----------
  const patch = (file, subs) => {
    let t = fs.readFileSync(file, 'utf8');
    for (const [a, b] of subs) t = t.replace(new RegExp(a, 'm'), b);
    fs.writeFileSync(file, t);
  };
  patch(path.join(HOME, 'config/config.toml'), [
    ['^type = "flood"', 'type = "app"'],
    ['^laddr = "tcp://0\\.0\\.0\\.0:26656"', 'laddr = "tcp://127.0.0.1:26656"'],
    ['^pprof_laddr = "localhost:6060"', 'pprof_laddr = "127.0.0.1:6060"'],
  ]);
  patch(path.join(HOME, 'config/app.toml'), [
    ['^evm-chain-id = .*', `evm-chain-id = ${EVM_CHAIN_ID}`],
    ['^minimum-gas-prices = .*', `minimum-gas-prices = "1${DENOM}"`],
    ['^enable = false', 'enable = true'],
    ['^enabled = false', 'enabled = true'],
    ['address = "tcp://localhost:1317"', 'address = "tcp://127.0.0.1:1317"'],
    ['address = "localhost:9090"', 'address = "127.0.0.1:9090"'],
  ]);
  evmd(['genesis', 'validate-genesis', '--home', HOME]);
  log('genesis valid');

  // ---------- start node ----------
  const logFd = fs.openSync(CHAIN_LOG, 'w');
  const node = spawn(EVMD, [
    'start',
    '--home', HOME,
    '--chain-id', COSMOS_CHAIN_ID,
    '--minimum-gas-prices', `1${DENOM}`,
    '--evm.evm-chain-id', String(EVM_CHAIN_ID),
    '--evm.min-tip', '0',
    '--pruning', 'nothing',
    '--json-rpc.enable', 'true',
    '--json-rpc.address', '127.0.0.1:8545',
    '--json-rpc.api', 'eth,txpool,personal,net,debug,web3',
  ], { stdio: ['ignore', logFd, logFd], detached: false, env });

  fs.writeFileSync('/tmp/opencode/nexora-demo-chain.pid', String(node.pid));
  log(`evmd started (pid ${node.pid}), log: ${CHAIN_LOG}`);

  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const bn = await rpc('eth_blockNumber');
      const id = await rpc('eth_chainId');
      if (bn?.result && id?.result === EVM_CHAIN_ID_HEX) { ready = true; break; }
    } catch { /* wait */ }
    if (node.exitCode !== null) {
      fail(`evmd exited (code ${node.exitCode}). Log:\n${fs.readFileSync(CHAIN_LOG, 'utf8').slice(-2000)}`);
    }
  }
  if (!ready) fail('RPC did not become ready within 120s. Log:\n' + fs.readFileSync(CHAIN_LOG, 'utf8').slice(-2000));
  log(`chain up: chainId=${EVM_CHAIN_ID_HEX} RPC=${RPC}`);

  // ---------- deploy contracts ----------
  const dev0 = keys.dev0;
  const castEnv = { env };
  const send = (args) => run(CAST, [...args, '--rpc-url', RPC, '--private-key', dev0.pk, '--gas-price', GAS_PRICE_FLAG], { env: castEnv.env });

  log('compiling contracts (forge, via_ir)…');
  run(FORGE, ['build', '--root', CONTRACTS_DIR], { env: castEnv.env });

  const contracts = {};
  log('deploying tokens + oracle');
  for (const t of TOKENS) {
    const aid = '0x' + keccak32(`nexora:aid:${t.symbol.toLowerCase()}`);
    const assetClass = '0x' + keccak32(t.assetClass);
    const out = run(FORGE, [
      'create',
      `src/AssetToken.sol:AssetToken`,
      '--root', CONTRACTS_DIR,
      '--rpc-url', RPC,
      '--private-key', dev0.pk,
      '--gas-price', GAS_PRICE_FLAG,
      '--broadcast',
      '--constructor-args', t.name, t.symbol, '18', aid, assetClass, `nexora://demo/${t.symbol.toLowerCase()}`, dev0.evmAddress,
    ], { env: castEnv.env });
    const m = out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/) || out.match(/Address:\s*(0x[0-9a-fA-F]{40})/);
    if (!m) fail(`no address in forge create output:\n${out.slice(-600)}`);
    contracts[t.symbol] = { name: t.name, symbol: t.symbol, address: m[1], instrument: t.instrument, decimals: 18, assetClass: t.assetClass };
    log(`  ${t.symbol} -> ${m[1]}`);
  }
  {
    const out = run(FORGE, [
      'create', 'src/MockOracle.sol:MockOracle',
      '--root', CONTRACTS_DIR,
      '--rpc-url', RPC,
      '--private-key', dev0.pk,
      '--gas-price', GAS_PRICE_FLAG,
      '--broadcast',
      '--constructor-args', dev0.evmAddress, '300',
    ], { env: castEnv.env });
    const m = out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/) || out.match(/Address:\s*(0x[0-9a-fA-F]{40})/);
    if (!m) fail(`no address in forge create output:\n${out.slice(-600)}`);
    contracts.oracle = { address: m[1], maxStaleness: 300 };
    log(`  oracle -> ${m[1]}`);
  }

  // ---------- seed: mint + oracle prices ----------
  log('seeding balances (real mint txs)');
  const E18 = WEI18;
  const mints = [
    ['nUSD', keys.alice.evmAddress, 100000n * E18],
    ['nUSD', keys.bob.evmAddress, 100000n * E18],
    ['nUSD', keys.mm.evmAddress, 500000n * E18],
    ['nXAU', keys.mm.evmAddress, 500n * E18],
    ['nBTC', keys.mm.evmAddress, 2n * E18],
    ['nEUR', keys.mm.evmAddress, 50000n * E18],
  ];
  for (const [sym, to, amount] of mints) {
    const tx = send(['send', contracts[sym].address, 'mint(address,uint256)', to, amount.toString()]);
    const h = (tx.match(/transactionHash\s+(0x[0-9a-fA-F]{64})/) || tx.match(/(0x[0-9a-fA-F]{64})/) || [])[1];
    log(`  mint ${sym} ${amount / E18} -> ${to.slice(0, 10)}… tx=${h || '?'}`);
  }

  log('pushing seed prices to on-chain oracle (scaled by 10^decimals, like Chainlink feeds)');
  for (const [instrument, p] of Object.entries(SEED_PRICES)) {
    const assetKey = '0x' + keccak32(instrument);
    send(['send', contracts.oracle.address, 'pushPrice(bytes32,uint256,uint8,bytes32)', assetKey, String(p.price), String(p.decimals), '0x0000000000000000000000000000000000000000000000000000000000000000']);
    log(`  oracle ${instrument} = ${p.price / 1e8}`);
  }

  // ---------- write state ----------
  const state = {
    mode: 'chain',
    rpc: RPC,
    chainId: EVM_CHAIN_ID,
    chainIdHex: EVM_CHAIN_ID_HEX,
    cosmosChainId: COSMOS_CHAIN_ID,
    evmdHome: HOME,
    evmdBinary: EVMD,
    evmdPid: node.pid,
    quoteCurrency: { symbol: 'nUSD', contract: contracts.nUSD.address, decimals: 18 },
    nativeToken: { denom: DENOM, symbol: 'ANEX', decimals: 18 },
    tokens: {
      nUSD: contracts.nUSD, nXAU: contracts.nXAU, nBTC: contracts.nBTC, nEUR: contracts.nEUR,
    },
    oracle: contracts.oracle,
    markets: TOKENS.filter(t => t.instrument).map(t => ({
      instrument: t.instrument, base: t.symbol, quote: 'nUSD', baseContract: contracts[t.symbol].address,
      quoteContract: contracts.nUSD.address, decimals: 18,
    })),
    accounts: {
      mykey: { name: 'mykey', address: keys.mykey.address, role: 'validator' },
      dev0: { name: 'dev0', address: keys.dev0.address, evmAddress: keys.dev0.evmAddress, pk: keys.dev0.pk, role: 'admin/operator' },
      alice: { name: 'alice', address: keys.alice.address, evmAddress: keys.alice.evmAddress, pk: keys.alice.pk, role: 'trader' },
      bob: { name: 'bob', address: keys.bob.address, evmAddress: keys.bob.evmAddress, pk: keys.bob.pk, role: 'trader' },
      mm: { name: 'mm', address: keys.mm.address, evmAddress: keys.mm.evmAddress, pk: keys.mm.pk, role: 'market-maker' },
    },
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  log(`state written: ${STATE}`);
  log('bootstrap complete. start the exchange with: node source/demo-exchange/server.mjs');
  node.unref();
}

main().catch((e) => fail(e.message || String(e)));
