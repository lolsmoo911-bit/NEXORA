#!/usr/bin/env node
/**
 * Custorium Exchange v2 — REAL trading + self-custody Web3 wallet (TESTNET/DEVNET ONLY).
 *
 * CEX model (like Binance):
 *   - matching engine off-chain (source/exchange/src/matching-engine.mjs)
 *   - trading-account balances = in-memory ledger BACKED 1:1 by the on-chain custody address
 *   - deposits   = user-signed ERC20 transfers (browser Web3 wallet) → custody; detected via
 *                  eth_getLogs(Transfer) and credited automatically
 *   - withdrawals = real custody ERC20 transfers, signed by the custody key, after EIP-191
 *                  signature auth verified through the ecrecover precompile (0x01) on-chain
 *   - Web3 wallet = browser-held key only (localStorage); the server never sees private keys
 *   - faucet      = real mint txs from the admin key straight to the user's wallet address
 *   - keeper      = market-maker inventory moved on-chain into custody, credited by the watcher
 *
 * User identity = wallet address. Orders/cancels/withdraws require a signed session
 * (challenge → personal_sign → ecrecover) so only the key holder can act.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createMatchingEngine } from '../exchange/src/matching-engine.mjs';

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname, '../..');
const CAST = process.env.CAST_BIN || path.join(WORKSPACE, '.foundry/versions/foundry-rs/foundry/v1.8.5/cast');
const CHAIN_STATE_PATH = process.env.CHAIN_STATE || '/tmp/opencode/demo-chain-state.json';
const STATE_PATH = process.env.EXCHANGE_STATE || '/tmp/opencode/nexora-exchange-state.json';
const PORT = Number(process.env.PORT || 4173);
// Chain gas price: the Custorium devnet (denom csto) enforces minimum-gas-prices
// 0.0001csto (1e14 wei). Default to 1.1x so txs are accepted while cast's own
// max-cost preflight (gasLimit × gasPrice) stays small for low-gas accounts.
const GAS_PRICE = process.env.CHAIN_GAS_PRICE || '110000000000000';
const publicDir = path.join(__dirname, 'public');

const ZERO32 = '0x' + '00'.repeat(32);
const W8 = 10n ** 8n;
const ECRECOVER = '0x0000000000000000000000000000000000000001';
const ZERO_ADDR = '0x' + '0'.repeat(40); // ERC20 mint/burn pseudo-address (keys keep the 0x prefix)
const TRANSFER_EVENT = 'Transfer(address,address,uint256)';
const SELECTOR_BALANCE_OF = '0x70a08231';
const FAUCET_AMOUNTS = { nUSD: '10000', nXAU: '2', nBTC: '0.05', nEUR: '5000' };
// Convert inventory: tokens the exchange itself owns (held in custody, tracked in its
// ledger book "K"), minted by admin at bootstrap so Convert swaps against REAL inventory.
const CONVERT_INVENTORY = { nUSD: 50000, nXAU: 10, nBTC: 0.2, nEUR: 20000 };
const FAUCET_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12h per address
const TAKER_FEE = 0.001; // 0.1% per side — settles into the exchange inventory book (revenue)
// Listed tokens (real-world stock tokens deployed by the treasury per the Custorium plan):
// discovered from the Custorium Scan explorer, priced by its exchange_rate values.
const EXPLORER = process.env.EXPLORER_URL || 'https://nexora-scan.sageswap.dpdns.org';
const STOCK_DEPLOYER = process.env.STOCK_DEPLOYER || '0x5252Df44321172ac34d1aFD423f36e7D4fAC239e'; // w05 (distribution plan)
const CORE_SYMBOLS = new Set(['nUSD', 'nXAU', 'nBTC', 'nEUR']);
const STOCK_NOTIONAL_TARGET = 2500; // ~nUSD of book inventory per stock quote
const PROVIDER_NUSD = 30000;        // nUSD allocated once from custody inventory (K) to the stock provider book
const MIGRATE_BATCH = 6;            // stock tokens moved to custody per keeper tick
const RECONCILE_BATCH = 80;         // custody balances chain-verified per reconcile slice
const DEFAULT_QTY = { XAUUSD: 5, BTCUSD: 0.5, EURUSD: 20000 };
const FALLBACK_PRICES = { XAUUSD: 2350, BTCUSD: 65000, EURUSD: 1.08 };

const log = (...a) => console.log('[custorium-exchange]', ...a);
const fail = (m) => { console.error('[custorium-exchange] FATAL:', m); process.exit(1); };

// ---------------------------------------------------------------- chain state
if (!fs.existsSync(CHAIN_STATE_PATH)) fail(`chain state missing (${CHAIN_STATE_PATH}) — run: node source/nexora-exchange/chain/bootstrap.mjs`);
const chain = JSON.parse(fs.readFileSync(CHAIN_STATE_PATH, 'utf8'));
const RPC = chain.rpc;
let tokenBySymbol = { ...chain.tokens };
const marketByInstrument = new Map(chain.markets.map(m => [m.instrument, m]));
const adminPk = resolveAdminPk();
const mmPk = chain.accounts.mm.pk;
const mmEvm = chain.accounts.mm.evmAddress;
const adminEvm = await (async () => { // w05 (or legacy dev0) EVM address — the stock-provider book
  try {
    const { stdout } = await exec(CAST, ['wallet', 'address', '--private-key', adminPk], { timeout: 15_000 });
    return stdout.trim();
  } catch { return chain.accounts.admin?.evmAddress || chain.accounts.dev0?.evmAddress; }
})();
if (!fs.existsSync(CAST)) fail(`cast not found at ${CAST}`);

/**
 * Admin/gas account. The Custorium distribution plan designates the treasury wallet
 * w05 (unfrozen, funded with native CSTO) as the sanctioned contract deployer/admin
 * ("ويمكن استخدامها كـ deployer عند التمويل بالغاز" — nexora-plan/custorium_distribution_plan.json).
 * Resolution order: CUSTORIUM_ADMIN_PK env > /tmp/opencode/custorium-admin-pk file >
 * w05 exported from the plan's test keyring > legacy dev0 (self-bootstrapped chains).
 */
function resolveAdminPk() {
  const envPk = process.env.CUSTORIUM_ADMIN_PK;
  if (envPk) return envPk.startsWith('0x') ? envPk : '0x' + envPk;
  const filePk = '/tmp/opencode/custorium-admin-pk';
  try {
    const pk = fs.readFileSync(filePk, 'utf8').trim();
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) return pk.startsWith('0x') ? pk : '0x' + pk;
  } catch { /* not present */ }
  try {
    const EVMD = path.join(WORKSPACE, 'nexora-chain/cosmos-evm/build/evmd');
    const out = execSync(EVMD + ' keys unsafe-export-eth-key w05 --keyring-backend test --home ' + path.join(WORKSPACE, 'nexora-plan/keys'), { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(out)) return out.startsWith('0x') ? out : '0x' + out;
  } catch { /* plan keyring not available */ }
  return chain.accounts.admin?.pk || chain.accounts.dev0.pk;
}

// ---------------------------------------------------------------- exchange state (persisted)
const state = {
  custody: null,                 // {address, pk}
  depositCursor: null,           // last processed block head marker (null = scan from genesis)
  ledger: {},                    // address(lowercase) -> {symbol: units}
  positions: {},                 // address -> instrument -> {qty, avgPrice, realizedPnl}
  orders: {},                    // orderId -> {id, address, instrument, side, price, quantity, remaining, status, timestamp}
  deposits: [],                  // {txHash, address, symbol, amountRaw, block, timestamp}
  withdrawals: [],               // {txHash, address, symbol, amount, to, timestamp}
  trades: [],                    // {id, instrument, price, quantity, timestamp, buyer, seller}
  converts: [],                  // {timestamp, address, from, to, fromAmount, toAmount}
  faucet: {},                    // address -> last faucet ts
};
if (fs.existsSync(STATE_PATH)) {
  try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))); }
  catch (e) { log(`warning: could not parse state file (${e.message}) — starting fresh`); }
}
state.ledger ||= {}; state.positions ||= {}; state.orders = {}; state.deposits ||= [];
state.withdrawals ||= []; state.trades ||= []; state.converts ||= []; state.faucet ||= {};
state.processedTxs ||= {};
state.stockRegistry ||= {};    // symbol -> {address, decimals, name, price} — listed stock tokens
state.custodyChain ||= {};     // symbol -> raw custody balance cache (watcher-maintained, chain-reconciled)
state.stockProviderFunded ||= false; // one-time nUSD allocation from inventory K to the stock provider book
state.migratedStocks ||= {};   // symbol -> true once its provider inventory moved into custody

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch (e) { log(`state save failed: ${e.message}`); }
  }, 300);
}

// ---------------------------------------------------------------- primitives
async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result;
}
const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const headNumber = async () => Number(BigInt(await rpc('eth_blockNumber')));

const pad64 = (hex) => String(hex).replace(/^0x/, '').padStart(64, '0');
const word = (hex, i) => hex.replace(/^0x/, '').slice(i * 64, i * 64 + 64);
const decOf = (symbol) => Number(tokenBySymbol[symbol]?.decimals ?? 18);
const toUnits = (raw, dec = 18) => Number(raw) / 10 ** Number(dec);
const raw18 = (units) => BigInt(Math.round(Number(units) * 1e18));
const rawUnits = (units, dec = 18) => BigInt(Math.max(0, Math.round(Number(units) * 10 ** Number(dec))));
const price8 = (units) => BigInt(Math.round(Number(units) * 1e8));
const lower = (a) => String(a || '').toLowerCase();
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));

async function balanceOfRaw(token, evmAddress) {
  const out = await ethCall(token, SELECTOR_BALANCE_OF + pad64(evmAddress));
  return BigInt(out === '0x' ? '0x0' : out);
}
const nativeBalanceRaw = (evmAddress) => rpc('eth_getBalance', [evmAddress, 'latest']).then(h => BigInt(h));

async function castSend({ to, sig, args = [], from, value }) {
  const argv = ['send', to, ...(sig ? [sig, ...args] : []), '--rpc-url', RPC, '--private-key', from, '--gas-price', GAS_PRICE, '--json'];
  // explicit gas limit — node gas estimates can come back capped (e.g. 50000) and an
  // ERC20 transfer/mint needs slightly more, which surfaces as
  // "gas required exceeds allowance (50000)"
  argv.push('--gas-limit', process.env.CHAIN_GAS_LIMIT || '600000');
  if (value) argv.push('--value', value);
  let stdout;
  try {
    ({ stdout } = await exec(CAST, argv, { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 }));
  } catch (e) {
    const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join(' | ').slice(-500);
    throw new Error(`cast send ${sig || '(native)'} failed: ${detail}`);
  }
  const receipt = JSON.parse(stdout.trim());
  if (receipt.status !== '0x1') throw new Error(`tx reverted (${receipt.transactionHash || ''})`);
  return { transactionHash: receipt.transactionHash, blockNumber: Number(BigInt(receipt.blockNumber ?? '0x0')) };
}

async function keccak(text) {
  const { stdout } = await exec(CAST, ['keccak', text], { timeout: 15_000 });
  return stdout.trim().replace(/^0x/, '');
}
function eip191Hash(message) { return '\x19Ethereum Signed Message:\n' + message.length + message; }

async function ecrecoverAddress(message, sigHex) {
  const hash = await keccak(eip191Hash(message));
  const s = String(sigHex).replace(/^0x/, '');
  if (s.length !== 130) throw new Error('invalid signature length');
  const r = s.slice(0, 64), sv = s.slice(64, 128), vb = s.slice(128, 130);
  let v = parseInt(vb, 16); if (v < 27) v += 27;
  const data = '0x' + hash + pad64(v.toString(16)) + r + sv;
  const out = await ethCall(ECRECOVER, data);
  return '0x' + out.replace(/^0x/, '').slice(-40);
}

// ---------------------------------------------------------------- oracle / marks
const marks = new Map(); // instrument -> {price, ts, source}
const assetKeys = new Map();
let ORACLE_GET_PRICE = null;
async function initOracle() {
  for (const m of chain.markets) assetKeys.set(m.instrument, await keccak(m.instrument));
  const { stdout } = await exec(CAST, ['sig', 'getPrice(bytes32)'], { timeout: 15_000 });
  ORACLE_GET_PRICE = stdout.trim();
}
async function getFeedOnChain(instrument) {
  const out = await ethCall(chain.oracle.address, ORACLE_GET_PRICE + pad64(assetKeys.get(instrument)));
  if (out === '0x') return null;
  return {
    price: BigInt('0x' + word(out, 0)),
    decimals: Number(BigInt('0x' + word(out, 1))),
    updatedAt: Number(BigInt('0x' + word(out, 2))) * 1000,
    fresh: word(out, 3).slice(-2) !== '00',
  };
}
async function pushPriceOnChain(instrument, priceUnits) {
  return castSend({
    to: chain.oracle.address, sig: 'pushPrice(bytes32,uint256,uint8,bytes32)',
    args: [assetKeys.get(instrument), price8(priceUnits).toString(), '8', ZERO32], from: adminPk,
  });
}
const markOf = (i) => marks.get(i)?.price ?? null;

// ---------------------------------------------------------------- ledger
function ledgerOf(address) {
  const k = lower(address);
  state.ledger[k] ||= {};
  return state.ledger[k];
}
function ledgerBalance(address, symbol) { return ledgerOf(address)[symbol] ?? 0; }
function ledgerAdd(address, symbol, units) {
  const l = ledgerOf(address);
  l[symbol] = Math.max(0, Number(((l[symbol] ?? 0) + units).toFixed(12)));
  saveState();
}
function openLocksUnits(address, symbol) {
  let sum = 0;
  for (const o of Object.values(state.orders)) {
    if (lower(o.address) !== lower(address)) continue;
    if (o.status !== 'open' && o.status !== 'partially_filled') continue;
    const mk = marketByInstrument.get(o.instrument);
    if (!mk) continue;
    if (o.side === 'buy' && symbol === 'nUSD') sum += o.price * o.remaining * (1 + TAKER_FEE);
    if (o.side === 'sell' && symbol === mk.base) sum += o.remaining;
  }
  return sum;
}
function ledgerAvailable(address, symbol) {
  const bal = ledgerBalance(address, symbol);
  const locked = openLocksUnits(address, symbol);
  return { balance: bal, locked, available: Math.max(0, bal - locked) };
}
function positionsOf(address) {
  const k = lower(address);
  state.positions[k] ||= {};
  return state.positions[k];
}
function applyFillPositions(address, side, trade) {
  const ps = positionsOf(address);
  const p = ps[trade.instrument] || (ps[trade.instrument] = { qty: 0, avgPrice: 0, realizedPnl: 0 });
  const q = trade.quantity, price = trade.price;
  if (side === 'buy') {
    if (p.qty >= 0) { p.avgPrice = (p.avgPrice * p.qty + price * q) / (p.qty + q); p.qty += q; }
    else { const cover = Math.min(q, -p.qty); p.realizedPnl += (p.avgPrice - price) * cover; p.qty += q; if (p.qty > 0) p.avgPrice = price; }
  } else {
    if (p.qty > 0) {
      const close = Math.min(q, p.qty);
      p.realizedPnl += (price - p.avgPrice) * close; p.qty -= q;
      if (p.qty < 0) p.avgPrice = price;
    } else if (p.qty === 0) { p.qty -= q; p.avgPrice = price; }
    else { p.avgPrice = (p.avgPrice * -p.qty + price * q) / (-p.qty + q); p.qty -= q; }
  }
  saveState();
}

// ---------------------------------------------------------------- sessions (signature auth)
const sessions = new Map(); // token -> {address, exp}
const challenges = new Map(); // nonce -> {address, exp}
const newToken = () => crypto.randomBytes(16).toString('hex');
function authGuard(req, body) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const s = token && sessions.get(token);
  if (!s || s.exp < Date.now()) throw new Error('unauthorized: sign a session first (Wallet tab)');
  if (lower(s.address) !== lower(body.address)) throw new Error('session address mismatch');
  sessions.set(token, { ...s, exp: Date.now() + 30 * 60 * 1000 });
  return token;
}

// ---------------------------------------------------------------- serialized ops
let opChain = Promise.resolve();
function enqueue(fn) {
  const p = opChain.then(fn, fn);
  opChain = p.catch(() => {});
  return p;
}

// ---------------------------------------------------------------- listed tokens registry (Custorium Scan)
let addressToSymbol = new Map(Object.entries(tokenBySymbol).map(([s, t]) => [lower(t.address), s]));
async function fetchJSON(url, timeoutMs = 20_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`explorer ${res.status}`);
  return res.json();
}

/** Discover listed stock tokens from the explorer and register them as nUSD markets. */
async function syncTokenRegistry() {
  let added = 0;
  try {
    const balances = await fetchJSON(`${EXPLORER}/api/v2/addresses/${STOCK_DEPLOYER}/token-balances?type=ERC-20`);
    for (const t of balances) {
      const tok = t.token || {};
      const symbol = String(tok.symbol || '').trim();
      if (!symbol || CORE_SYMBOLS.has(symbol) || tokenBySymbol[symbol]) continue;
      const known = state.stockRegistry[symbol];
      if (known) {
        if (tok.address) known.address = tok.address;
        continue;
      }
      state.stockRegistry[symbol] = {
        address: tok.address, decimals: Number(tok.decimals ?? 0),
        name: tok.name || symbol, price: Number(tok.exchange_rate) > 0 ? Number(tok.exchange_rate) : null,
      };
      state.custodyChain[symbol] ||= '0';
      added++;
    }
  } catch (e) {
    log(`explorer registry sync failed (${e.message}) — using cached registry (${Object.keys(state.stockRegistry).length} tokens)`);
  }
  if (added) { log(`token registry: +${added} listed tokens (total ${Object.keys(state.stockRegistry).length})`); saveState(); }
  rebuildListedMarkets();
  buildStockMigrateQueue(); // (re)build the progressive provider-inventory migration queue
}

/** Fill missing listed-token prices from the explorer (bounded per call; runs in background). */
async function fillListedPrices(maxLookups = 100) {
  const need = Object.entries(state.stockRegistry).filter(([, e]) => !e.price).slice(0, maxLookups);
  let filled = 0;
  for (const [symbol, e] of need) {
    try {
      const d = await fetchJSON(`${EXPLORER}/api/v2/tokens/${e.address}`, 15_000);
      const p = Number(d.exchange_rate);
      if (p > 0) { e.price = p; marks.set(symbol, { price: p, ts: Date.now(), source: 'listed' }); filled++; }
    } catch { /* retry next cycle */ }
  }
  if (filled) {
    log(`listed prices: +${filled} (missing ${Object.values(state.stockRegistry).filter(x => !x.price).length})`);
    saveState();
    buildStockMigrateQueue(); // prices changed → re-sort the migration queue (price desc)
  }
}

/** Merge core markets + listed stock tokens into the live market/token indexes. */
function rebuildListedMarkets() {
  for (const m of chain.markets) marketByInstrument.set(m.instrument, { ...m, stock: false });
  for (const [symbol, e] of Object.entries(state.stockRegistry)) {
    if (!e.address) continue;
    tokenBySymbol[symbol] = { symbol, address: e.address, decimals: e.decimals, name: e.name, stock: true };
    marketByInstrument.set(symbol, {
      instrument: symbol, symbol, base: symbol, quote: 'nUSD', name: e.name,
      baseContract: e.address, decimals: e.decimals, stock: true,
    });
    marks.set(symbol, { price: e.price, ts: Date.now(), source: 'listed' });
  }
  addressToSymbol = new Map(Object.entries(tokenBySymbol).map(([s, t]) => [lower(t.address), s]));
}

// ---------------------------------------------------------------- deposits watcher
let TRANSFER_TOPIC0 = null;
/** custody raw-balance cache: +credit on deposits, −on withdrawals, chain-reconciled periodically */
function bumpCustodyChain(symbol, rawDelta) {
  state.custodyChain[symbol] = (BigInt(state.custodyChain[symbol] ?? '0') + rawDelta).toString();
}
async function depositWatcherTick() {
  if (!state.custody || !TRANSFER_TOPIC0) return;
  const head = await headNumber();
  const from = state.depositCursor == null ? 0 : state.depositCursor;
  const to = head - 1;
  if (to < from) return;
  // ONE getLogs for ALL listed tokens (custody as Transfer recipient) — 543 per-token
  // queries per tick would be far too heavy on the node
  let logs = [];
  try {
    logs = await rpc('eth_getLogs', [{
      topics: [TRANSFER_TOPIC0, null, '0x' + pad64(state.custody.address)],
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
    }]);
  } catch (e) { log(`watcher getLogs: ${e.message}`); return; } // keep cursor; retried next tick
  const ck = lower(state.custody.address);
  for (const lg of logs) {
    try {
      const symbol = addressToSymbol.get(lower(lg.address));
      if (!symbol) continue; // an unlisted ERC20 touched custody — not a platform asset
      const key = `${lg.transactionHash}:${lg.logIndex ?? '0'}`;
      if (state.processedTxs[key]) continue; // idempotent: rescans never double-credit
      const fromAddr = '0x' + (lg.topics[1] || '').slice(-40);
      if (lower(fromAddr) === ck) continue; // custody outgoing (withdrawal) — not a deposit
      if (lower(fromAddr) === ZERO_ADDR) continue; // mints (from=0x0) are NOT deposits
      // ERC20 Transfer: topic1=from, topic2=to, value in DATA (OpenZeppelin layout)
      const amount = BigInt(lg.data && lg.data !== '0x' ? lg.data : '0x0');
      if (amount <= 0n) continue;
      const units = toUnits(amount, decOf(symbol));
      ledgerAdd(fromAddr, symbol, units);
      bumpCustodyChain(symbol, amount); // custody is the recipient: its balance grew
      state.processedTxs[key] = true;
      state.deposits.push({
        txHash: lg.transactionHash, address: lower(fromAddr), symbol,
        amount: units, amountRaw: amount.toString(), block: Number(BigInt(lg.blockNumber)), timestamp: Date.now(),
      });
      if (state.deposits.length > 2000) state.deposits.splice(0, state.deposits.length - 2000);
      log(`deposit credited: ${symbol} ${units} → ${fromAddr.slice(0, 10)}… (tx ${lg.transactionHash.slice(0, 14)}…)`);
    } catch (e) { log(`deposit log skipped: ${e.message}`); }
  }
  state.depositCursor = head; saveState();
}

// ---------------------------------------------------------------- settlement (ledger, CEX-style)
async function settleTrade(trade) {
  const buyer = lower(state.orders[trade.buyOrderId]?.address);
  const seller = lower(state.orders[trade.sellOrderId]?.address);
  const mk = marketByInstrument.get(trade.instrument);
  if (!mk || !buyer || !seller) throw new Error('settlement: missing order metadata');

  const notional = trade.price * trade.quantity;
  const feeB = notional * TAKER_FEE, feeS = notional * TAKER_FEE;
  ledgerAdd(buyer, 'nUSD', -(notional + feeB));
  ledgerAdd(buyer, mk.base, trade.quantity);
  ledgerAdd(seller, mk.base, -trade.quantity);
  ledgerAdd(seller, 'nUSD', notional - feeS);
  // exchange revenue accumulates in the custody inventory book (K) — visible in /api/backing
  ledgerAdd(state.custody.address, 'nUSD', feeB + feeS);
  applyFillPositions(buyer, 'buy', trade);
  applyFillPositions(seller, 'sell', trade);

  for (const id of [trade.buyOrderId, trade.sellOrderId]) {
    const o = state.orders[id];
    if (!o) continue;
    o.remaining = Math.max(0, o.remaining - trade.quantity);
    o.status = o.remaining === 0 ? 'filled' : (o.remaining < o.quantity ? 'partially_filled' : o.status);
  }
  const rec = {
    id: trade.id, instrument: trade.instrument, price: trade.price, quantity: trade.quantity,
    timestamp: trade.timestamp, buyer, seller, buyerFee: Number(feeB.toFixed(8)), sellerFee: Number(feeS.toFixed(8)),
    buyerOrderId: trade.buyOrderId, sellerOrderId: trade.sellOrderId,
  };
  state.trades.push(rec);
  if (state.trades.length > 1000) state.trades.splice(0, state.trades.length - 1000);
  return rec;
}

// ---------------------------------------------------------------- order flow
async function placeOrderFlow({ address, instrument, side, price, quantity, type = 'limit' }) {
  if (!isAddress(address)) throw new Error('valid wallet address required');
  const mk = marketByInstrument.get(instrument);
  if (!mk) throw new Error(`unknown instrument "${instrument}"`);
  if (side !== 'buy' && side !== 'sell') throw new Error('side must be buy or sell');
  quantity = Number(quantity);
  if (!(quantity > 0) || !Number.isFinite(quantity)) throw new Error('quantity must be a positive number');
  // whole-share tokens (all listed stocks are decimals=0): fractional ledger quantities
  // could not be withdrawn 1:1 — keep books exact
  if (decOf(mk.base) === 0 && !Number.isInteger(quantity)) throw new Error('whole shares only for this token (decimals = 0)');

  const isMarket = type === 'market';
  if (isMarket) {
    // marketable-limit IOC: cap at the worst level needed to fill `quantity` from the book
    const book = engine.getBook(instrument, { depth: 100 });
    const levels = side === 'buy' ? book.asks : book.bids;
    if (!levels.length) throw new Error('no liquidity on the book for a market order right now');
    let acc = 0, worst = levels[levels.length - 1].price;
    for (const l of levels) { acc += l.remaining; if (acc >= quantity) { worst = l.price; break; } }
    price = worst;
  } else {
    price = Number(price);
    if (!(price > 0) || !Number.isFinite(price)) throw new Error('price must be a positive number');
  }

  const needSymbol = side === 'buy' ? 'nUSD' : mk.base;
  const need = side === 'buy' ? price * quantity * (1 + TAKER_FEE) : quantity;
  const av = ledgerAvailable(address, needSymbol);
  if (av.available < need - 1e-9) {
    throw new Error(`insufficient ${needSymbol} in trading account: balance ${av.balance.toFixed(4)}, locked ${av.locked.toFixed(4)}, free ${av.available.toFixed(4)}, need ${need.toFixed(4)} — deposit from your Web3 wallet first`);
  }

  const id = `ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const ts = Date.now();
  const result = engine.placeOrder({ id, instrument, side, price, quantity, accountId: lower(address), timestamp: ts });
  state.orders[id] = { id, address: lower(address), instrument, side, type: isMarket ? 'market' : 'limit', price, quantity, remaining: result.order.remaining, status: result.order.status, timestamp: ts };

  const settled = [];
  try {
    for (const tr of result.trades) { const r = await settleTrade(tr); settled.push(r); }
  } catch (e) {
    const cur = engine.getOrder(id);
    if (cur) { state.orders[id].status = cur.status; state.orders[id].remaining = cur.remaining; }
    throw e;
  }
  const meta = state.orders[id];
  meta.status = engine.getOrder(id)?.status ?? result.order.status;
  meta.remaining = engine.getOrder(id)?.remaining ?? meta.remaining;

  // IOC semantics for market orders: cancel whatever did not fill
  let unfilled = 0;
  if (isMarket && meta.remaining > 0) {
    unfilled = meta.remaining;
    try { engine.cancelOrder(id); } catch {}
    meta.status = settled.length ? 'filled' : 'cancelled';
    meta.remaining = 0;
  }
  saveState();

  if (settled.length) {
    const last = settled[settled.length - 1];
    marks.set(instrument, { price: last.price, ts: last.timestamp, source: 'trade' });
    enqueue(() => pushPriceOnChain(instrument, last.price)).catch((e) => log(`oracle push skipped: ${e.message}`));
  }
  return {
    order: { ...meta },
    trades: settled,
    fills: settled.length,
    unfilled: isMarket ? unfilled : undefined,
  };
}

async function cancelOrderFlow({ address, orderId }) {
  const meta = state.orders[String(orderId)];
  if (!meta) throw new Error(`unknown order ${orderId}`);
  if (lower(meta.address) !== lower(address)) throw new Error('not your order');
  engine.cancelOrder(String(orderId));
  meta.status = 'cancelled';
  saveState();
  return { order: { ...meta } };
}

// ---------------------------------------------------------------- keeper (book liquidity)
let keeperBusy = false;
/** Progressive stock-inventory migration: provider (w05) transfers its holdings of the
 *  next MIGRATE_BATCH tokens into custody — the watcher then credits its book, and the
 *  keeper starts quoting that market. Sorted by price so the most valuable list first. */
let stockMigrateQueue = null;
function buildStockMigrateQueue() {
  stockMigrateQueue = Object.entries(state.stockRegistry)
    .filter(([s, e]) => e.address && !state.migratedStocks[s])
    .sort((a, b) => (b[1].price ?? 0) - (a[1].price ?? 0))
    .map(([s]) => s);
  if (stockMigrateQueue.length) log(`stock migration queue: ${stockMigrateQueue.length} tokens (by price desc)`);
}
async function migrateStockBatch() {
  if (!stockMigrateQueue || !stockMigrateQueue.length) return;
  // one-time: fund the provider's BUY side with an INTERNAL ledger move (K → provider book).
  // No chain tx: the nUSD tokens stay in custody, only book ownership changes —
  // custody_on_chain = customer_liabilities + K still holds exactly (K is re-derived
  // by syncInventory on every restart, so this is restart-safe).
  if (!state.stockProviderFunded) {
    const kNusd = ledgerBalance(state.custody.address, 'nUSD');
    if (kNusd >= PROVIDER_NUSD - 1e-9) {
      ledgerAdd(state.custody.address, 'nUSD', -PROVIDER_NUSD); // inventory K −
      ledgerAdd(adminEvm, 'nUSD', PROVIDER_NUSD);               // provider book + (custody-backed)
      state.stockProviderFunded = true; saveState();
      log(`stock provider funded: ${PROVIDER_NUSD} nUSD internal K → ${adminEvm.slice(0, 10)}… book (invariant preserved, no chain tx)`);
    } else {
      log(`stock provider funding deferred: inventory K ${kNusd.toFixed(0)} < ${PROVIDER_NUSD}`);
      return; // wait for K to reach the target before quoting buy sides
    }
  }
  const batch = stockMigrateQueue.splice(0, MIGRATE_BATCH);
  for (const symbol of batch) {
    try {
      const e = state.stockRegistry[symbol];
      const bal = await balanceOfRaw(e.address, adminEvm);
      if (bal <= 0n) { state.migratedStocks[symbol] = true; continue; }
      await castSend({ to: e.address, sig: 'transfer(address,uint256)', args: [state.custody.address, bal.toString()], from: adminPk });
      state.migratedStocks[symbol] = true; saveState();
      log(`stock inventory → custody: ${symbol} ${Number(bal)} (watcher credits next tick)`);
    } catch (err) {
      log(`migrate ${symbol} deferred: ${err.message}`);
      stockMigrateQueue.push(symbol);
      break; // stop the batch on the first failure; resumed next tick
    }
  }
}

async function keeperTick() {
  if (keeperBusy) return;
  keeperBusy = true;
  try {
    await migrateStockBatch();
    for (const m of marketByInstrument.values()) {
      const mark = markOf(m.instrument);
      if (!mark) continue;
      const provider = m.stock ? adminEvm : mmEvm;
      // book sizing: fixed map for core markets; notional-target derived for listed tokens
      let qty;
      if (m.stock) {
        const dec = decOf(m.base);
        const target = STOCK_NOTIONAL_TARGET / mark;
        qty = dec === 0 ? Math.max(1, Math.round(target)) : Math.max(0.0001, Number(target.toPrecision(4)));
      } else qty = DEFAULT_QTY[m.instrument] ?? 1;
      const tick = Math.max(mark < 10 ? 0.01 : 1, Math.round(mark * 0.002 * 100) / 100);
      const fmtPx = (p) => mark < 10 ? Math.round(p * 10000) / 10000 : Math.round(p * 100) / 100;
      if (ledgerBalance(provider, m.base) < 1 && ledgerBalance(provider, 'nUSD') < mark * qty) continue;
      for (const side of ['buy', 'sell']) {
        const openMm = Object.values(state.orders).filter(o =>
          lower(o.address) === lower(provider) && o.instrument === m.instrument && o.side === side
          && (o.status === 'open' || o.status === 'partially_filled'));
        if (openMm.length >= 2) continue;
        const px = fmtPx(side === 'buy' ? mark - tick : mark + tick);
        try { await placeOrderFlow({ address: provider, instrument: m.instrument, side, price: px, quantity: qty }); }
        catch { /* insufficient provider funds or book full — retry next tick */ }
      }
    }
  } finally { keeperBusy = false; }
}

// ---------------------------------------------------------------- custody bootstrap
async function bootstrapCustody() {
  if (!state.custody || !isAddress(state.custody.address)) {
    const pk = '0x' + crypto.randomBytes(32).toString('hex');
    const { stdout } = await exec(CAST, ['wallet', 'address', '--private-key', pk], { timeout: 15_000 });
    state.custody = { address: stdout.trim(), pk };
    saveState();
    log(`custody created: ${state.custody.address}`);
  }
  const gas = await nativeBalanceRaw(state.custody.address);
  if (gas < 10n ** 19n) {
    const r = await castSend({ to: state.custody.address, from: adminPk, value: (10n ** 21n).toString() });
    log(`custody gas funded by admin: 1000 CSTO (tx ${r.transactionHash.slice(0, 14)}…)`);
  }
  // mm needs native gas to move its inventory into custody (fresh chains give it none)
  const mmGas = await nativeBalanceRaw(mmEvm);
  if (mmGas < 5n * 10n ** 19n) {
    const r = await castSend({ to: mmEvm, from: adminPk, value: (10n ** 21n).toString() });
    log(`mm gas funded by admin: 1000 CSTO (tx ${r.transactionHash.slice(0, 14)}…)`);
  }
  // move mm inventory on-chain into custody ONCE; the deposit watcher credits mm's ledger
  const mmLedgerEmpty = Object.values(ledgerOf(mmEvm)).every(v => !v);
  if (mmLedgerEmpty) {
    for (const [symbol, token] of Object.entries(tokenBySymbol)) {
      const bal = await balanceOfRaw(token.address, mmEvm);
      if (bal <= 0n) continue;
      const r = await castSend({
        to: token.address, sig: 'transfer(address,uint256)',
        args: [state.custody.address, bal.toString()], from: mmPk,
      });
      log(`mm inventory moved to custody: ${symbol} ${toUnits(bal)} (tx ${r.transactionHash.slice(0, 14)}…)`);
    }
  }
}

// ---------------------------------------------------------------- account view
async function accountView(address) {
  if (!isAddress(address)) throw new Error('valid wallet address required');
  const k = lower(address);
  const l = ledgerOf(k);
  // 543 listed tokens: keep the payload light — core tokens always, others only when held/locked
  const balances = Object.keys(tokenBySymbol).map(symbol => ({ symbol, ...ledgerAvailable(k, symbol) }))
    .filter(b => CORE_SYMBOLS.has(b.symbol) || b.balance > 1e-12 || b.locked > 1e-12);
  const cash = l.nUSD ?? 0;
  let equity = cash;
  const positions = [];
  for (const m of marketByInstrument.values()) {
    const p = (state.positions[k] || {})[m.instrument];
    const bal = l[m.base] ?? 0;
    const px = markOf(m.instrument);
    // listed stocks: only rows with actual exposure or balance (543 mostly-empty rows would bloat every poll)
    if (m.stock && !(p?.qty > 0 || bal > 1e-12)) continue;
    const upnl = (p && px != null) ? (px - p.avgPrice) * p.qty : null;
    if (px != null) equity += bal * px;
    positions.push({
      instrument: m.instrument, base: m.base, qty: p?.qty ?? 0, avgPrice: p?.avgPrice ?? 0,
      markPrice: px, unrealizedPnl: upnl, realizedPnl: p?.realizedPnl ?? 0, balance: bal,
    });
  }
  const orders = Object.values(state.orders)
    .filter(o => lower(o.address) === k && (o.status === 'open' || o.status === 'partially_filled'))
    .sort((a, b) => b.timestamp - a.timestamp);
  const history = Object.values(state.orders)
    .filter(o => lower(o.address) === k && !['open', 'partially_filled'].includes(o.status))
    .sort((a, b) => b.timestamp - a.timestamp).slice(0, 30);
  const deposits = state.deposits.filter(d => d.address === k).slice(-20).reverse();
  const withdrawals = state.withdrawals.filter(d => d.address === k).slice(-20).reverse();
  const converts = state.converts.filter(d => d.address === k).slice(-20).reverse();
  const trades = state.trades.filter(t => t.buyer === k || t.seller === k).slice(-20).reverse();
  return { address: k, balances, positions, equity, orders, history, deposits, withdrawals, converts, trades, faucetReadyAt: nextFaucetAt(k) };
}
function nextFaucetAt(k) {
  const last = state.faucet[k] || 0;
  return Math.max(0, last + FAUCET_COOLDOWN_MS - Date.now());
}

// ---------------------------------------------------------------- flows: faucet / withdraw / convert
async function faucetFlow({ address }) {
  if (!isAddress(address)) throw new Error('valid wallet address required');
  const k = lower(address);
  if (Date.now() - (state.faucet[k] || 0) < FAUCET_COOLDOWN_MS) {
    throw new Error(`faucet cooldown: try again in ${Math.ceil(nextFaucetAt(k) / 60000)} minutes`);
  }
  const txs = {};
  // gas first: a fresh wallet cannot even sign a transfer without native CSTO
  const gas = await nativeBalanceRaw(address);
  if (gas < 10n ** 17n) {
    // 200 CSTO: enough for cast/browsers' max-cost preflight (gasLimit × gasPrice)
    // on chains with a 1e14 minimum gas price — actual charge is ~0.006 CSTO per tx
    const r = await castSend({ to: address, from: adminPk, value: (200n * 10n ** 18n).toString() });
    txs.CSTO = r.transactionHash;
    log(`faucet gas 200 CSTO → ${k.slice(0, 10)}… tx ${r.transactionHash.slice(0, 14)}…`);
  }
  for (const [symbol, amount] of Object.entries(FAUCET_AMOUNTS)) {
    const r = await castSend({
      to: tokenBySymbol[symbol].address, sig: 'mint(address,uint256)',
      args: [address, raw18(amount).toString()], from: adminPk,
    });
    txs[symbol] = r.transactionHash;
    log(`faucet mint ${symbol} ${amount} → ${k.slice(0, 10)}… tx ${r.transactionHash.slice(0, 14)}…`);
  }
  state.faucet[k] = Date.now();
  saveState();
  return { address: k, txs, amounts: FAUCET_AMOUNTS, note: 'minted straight to your Web3 wallet — real txs, check the chain' };
}

async function withdrawFlow({ address, symbol, amount, to }) {
  if (!isAddress(address) || !isAddress(to)) throw new Error('valid addresses required');
  const token = tokenBySymbol[symbol];
  if (!token) throw new Error(`unknown token "${symbol}"`);
  const amt = Number(amount);
  if (!(amt > 0) || !Number.isFinite(amt)) throw new Error('amount must be a positive number');
  // whole-share tokens (decimals = 0): a fractional withdrawal would round on-chain — refuse it
  if (decOf(symbol) === 0 && !Number.isInteger(amt)) throw new Error('whole shares only for this token (decimals = 0)');
  const av = ledgerAvailable(address, symbol);
  if (av.available < amt - 1e-9) throw new Error(`insufficient ${symbol} in trading account: free ${av.available.toFixed(6)} after locks`);
  // keep custody gas healthy
  const custodyGas = await nativeBalanceRaw(state.custody.address);
  if (custodyGas < 10n ** 17n) {
    await castSend({ to: state.custody.address, from: adminPk, value: (10n ** 20n).toString() });
    log('custody gas topped up');
  }
  const r = await castSend({
    to: token.address, sig: 'transfer(address,uint256)',
    args: [to, rawUnits(amt, decOf(symbol)).toString()], from: state.custody.pk,
  });
  ledgerAdd(address, symbol, -amt);
  bumpCustodyChain(symbol, -rawUnits(amt, decOf(symbol))); // custody paid out: cache follows
  const rec = { txHash: r.transactionHash, block: r.blockNumber, address: lower(address), symbol, amount: amt, to: lower(to), timestamp: Date.now() };
  state.withdrawals.push(rec);
  saveState();
  log(`withdraw ${symbol} ${amt} → ${lower(to).slice(0, 10)}… tx ${r.transactionHash.slice(0, 14)}…`);
  return rec;
}

async function convertFlow({ address, from, to, amount }) {
  // Convert runs against the exchange's own inventory (K) — only core tokens have
  // inventory targets; the 539 listed stocks trade on their own books, not via Convert.
  const valid = Object.fromEntries(Object.entries(tokenBySymbol).filter(([s]) => CORE_SYMBOLS.has(s)));
  if (!valid[from] || !valid[to]) throw new Error('unknown token');
  if (from === to) throw new Error('from and to must differ');
  const amt = Number(amount);
  if (!(amt > 0) || !Number.isFinite(amt)) throw new Error('amount must be a positive number');
  const priceFrom = symbolPrice(from), priceTo = symbolPrice(to);
  if (!priceFrom || !priceTo) throw new Error('no mark price for conversion');
  const FEE = 0.001; // 0.1%
  const valueIn = amt * priceFrom;
  const out = valueIn * (1 - FEE) / priceTo;
  const av = ledgerAvailable(address, from);
  if (av.available < amt - 1e-9) throw new Error(`insufficient ${from}: free ${av.available.toFixed(6)} after locks`);
  // Convert swaps against the exchange's OWN inventory (custody ledger book "K"):
  // the exchange receives `from` and pays out `to` from inventory it actually holds,
  // so the 1:1 backing proof (custody on-chain ≥ user liabilities) stays exact.
  const inventory = ledgerBalance(state.custody.address, to);
  if (inventory < out - 1e-9) {
    throw new Error(`exchange convert inventory exhausted for ${to}: ${inventory.toFixed(6)} available, need ${out.toFixed(8)} — inventory refills at next restart`);
  }
  ledgerAdd(address, from, -amt);
  ledgerAdd(address, to, out);
  ledgerAdd(state.custody.address, from, amt);  // exchange book receives `from`
  ledgerAdd(state.custody.address, to, -out);   // exchange book pays out `to`
  const rec = { timestamp: Date.now(), address: lower(address), from, to, fromAmount: amt, toAmount: Number(out.toFixed(12)), rate: Number((priceFrom / priceTo).toFixed(8)), fee: FEE };
  state.converts.push(rec);
  if (state.converts.length > 1000) state.converts.splice(0, state.converts.length - 1000);
  saveState();
  return rec;
}
function symbolPrice(symbol) {
  if (symbol === 'nUSD') return 1;
  const m = marketByInstrument.get(symbol) || chain.markets.find(x => x.base === symbol);
  return m ? markOf(m.instrument) : null;
}

// ---------------------------------------------------------------- inventory sync (Convert backing)
/**
 * Derive the exchange's own inventory book (custody ledger "K") from chain truth:
 *   custody_on_chain = user_liabilities + K   →   K = custody_on_chain - liabilities
 * If a historical deficit exists (claims created before inventory tracking, e.g. by
 * the old thin-air Convert), mint the missing amount to custody — a REAL mint tx — so
 * the 1:1 backing proof becomes exact again. Then top the convert inventory up to
 * CONVERT_INVENTORY targets (also real mints to custody).
 */
async function syncInventory() {
  const ck = lower(state.custody.address);
  delete state.ledger[ZERO_ADDR]; // purge ghost account if a dirty state ever contained one
  const k = ledgerOf(state.custody.address);
  for (const [symbol, token] of Object.entries(tokenBySymbol)) {
    const stock = !!token.stock;
    // listed tokens: custody balance from the watcher-maintained cache (reconciler verifies
    // against chain on a rolling basis) — 543 startup eth_calls would be far too slow
    const onChain = stock
      ? Number(BigInt(state.custodyChain[symbol] ?? '0')) / 10 ** decOf(symbol)
      : toUnits(await balanceOfRaw(token.address, state.custody.address), decOf(symbol));
    let liabilities = 0;
    for (const [addr, l] of Object.entries(state.ledger)) {
      if (addr === ck || addr === ZERO_ADDR) continue; // custody book is inventory; zero-addr is not a customer
      liabilities += l[symbol] ?? 0;
    }
    const derived = onChain - liabilities;
    if (derived < -1e-9) {
      const deficit = liabilities - onChain;
      if (deficit > 1000) {
        throw new Error(`backing deficit too large for auto-repair (${symbol}: ${deficit.toFixed(2)}) — if the chain was regenerated, wipe the exchange state file (${STATE_PATH}) and restart so custody/liabilities rebuild from scratch`);
      }
      const r = await castSend({ to: token.address, sig: 'mint(address,uint256)', args: [state.custody.address, raw18(deficit).toString()], from: adminPk });
      // verify on-chain: a tx to a codeless address "succeeds" as a no-op transfer
      const after = toUnits(await balanceOfRaw(token.address, state.custody.address));
      k[symbol] = Math.max(0, Number((after - liabilities).toFixed(12)));
      log(`backing repair: minted ${symbol} ${deficit.toFixed(8)} → custody (tx ${r.transactionHash.slice(0, 14)}…) verified K=${k[symbol]}`);
      continue;
    }
    k[symbol] = Math.max(0, Number(derived.toFixed(12)));
    const want = CONVERT_INVENTORY[symbol] ?? 0;
    if (k[symbol] < want - 1e-9) {
      const need = want - k[symbol];
      const r = await castSend({ to: token.address, sig: 'mint(address,uint256)', args: [state.custody.address, raw18(need).toString()], from: adminPk });
      const after = toUnits(await balanceOfRaw(token.address, state.custody.address)); // chain truth, not tx status
      k[symbol] = Math.max(0, Number((after - liabilities).toFixed(12)));
      log(`convert inventory topped up: ${symbol} +${need} → custody (tx ${r.transactionHash.slice(0, 14)}…) verified K=${k[symbol]}`);
    }
  }
  saveState();
}

async function reconcileCustodyBatch(n = RECONCILE_BATCH) {
  const syms = Object.keys(tokenBySymbol);
  if (!syms.length) return;
  state.reconcileIdx = Number(state.reconcileIdx ?? 0) % syms.length;
  let corrected = 0;
  for (let i = 0; i < n; i++) {
    const symbol = syms[(state.reconcileIdx + i) % syms.length];
    const token = tokenBySymbol[symbol];
    if (!token || !token.address) continue;
    try {
      const raw = await balanceOfRaw(token.address, state.custody.address);
      const cached = state.custodyChain[symbol];
      if (cached === undefined || BigInt(cached) !== raw) {
        if (cached !== undefined && BigInt(cached) !== raw) corrected++;
        state.custodyChain[symbol] = raw.toString();
      }
    } catch { /* keep cache; retried next cycle */ }
  }
  state.reconcileIdx = (state.reconcileIdx + n) % syms.length;
  if (corrected) log(`custody reconcile: ${corrected} cache drift(s) corrected (chain truth)`);
  saveState();
}

// ---------------------------------------------------------------- backing proof
async function backingView() {
  const ck = lower(state.custody.address);
  const rows = [];
  for (const [symbol, token] of Object.entries(tokenBySymbol)) {
    // custody on-chain balance from the reconciled cache (full per-call chain reads for
    // 543+ tokens would make this endpoint unusable; reconciler verifies continuously)
    const onChain = Number(BigInt(state.custodyChain[symbol] ?? '0')) / 10 ** decOf(symbol);
    let liabilities = 0;
    for (const [addr, l] of Object.entries(state.ledger)) {
      if (addr === ck || addr === ZERO_ADDR) continue; // exchange inventory / zero-addr are not customer liabilities
      liabilities += l[symbol] ?? 0;
    }
    rows.push({
      symbol, custodyOnChain: onChain, liabilities: Number(liabilities.toFixed(6)),
      inventory: Number((state.ledger[ck]?.[symbol] ?? 0).toFixed(6)),
      backed: onChain + 1e-9 >= liabilities,
    });
  }
  return {
    custody: state.custody.address, rows,
    allBacked: rows.every(r => r.backed),
    summary: {
      tokens: rows.length,
      backed: rows.filter(r => r.backed).length,
      verified: Object.keys(state.custodyChain).length,
      note: 'custody balances are watcher-maintained and chain-reconciled on a rolling basis',
    },
  };
}

// ---------------------------------------------------------------- http plumbing
const RPC_WHITELIST = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_gasPrice', 'eth_getBalance', 'eth_call',
  'eth_getTransactionCount', 'eth_estimateGas', 'eth_sendRawTransaction',
  'eth_getTransactionReceipt', 'eth_getLogs', 'eth_getBlockByNumber',
  'net_version', 'web3_clientVersion',
]);
async function rpcProxy(body) {
  const handle = async (item) => {
    if (!item || !RPC_WHITELIST.has(item.method)) return { jsonrpc: '2.0', id: item?.id ?? null, error: { code: -32601, message: 'method not allowed by proxy' } };
    try {
      const result = await rpc(item.method, item.params || []);
      return { jsonrpc: '2.0', id: item.id ?? null, result };
    } catch (e) {
      return { jsonrpc: '2.0', id: item.id ?? null, error: { code: -32000, message: e.message } };
    }
  };
  if (Array.isArray(body)) return Promise.all(body.map(handle));
  return handle(body);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('invalid JSON body'); }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png' };
function staticFile(res, rel) {
  const file = path.join(publicDir, rel);
  if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}

function marketsView({ q = null, limit = null } = {}) {
  let list = [...marketByInstrument.values()].map(m => {
    const mk = marks.get(m.instrument);
    return {
      symbol: m.instrument, base: m.base, quote: m.quote, name: `${tokenBySymbol[m.base]?.name ?? m.base} / nUSD`,
      assetClass: tokenBySymbol[m.base]?.assetClass ?? (m.stock ? 'listed-stock' : ''),
      stock: !!m.stock, decimals: m.decimals ?? tokenBySymbol[m.base]?.decimals ?? 18,
      price: mk?.price ?? null, updatedAt: mk?.ts ?? null, priceSource: mk?.source ?? null,
    };
  });
  if (q) {
    const needle = q.toLowerCase();
    list = list.filter(m => m.symbol.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));
  }
  list.sort((a, b) => Number(b.price ?? -1) - Number(a.price ?? -1));
  const total = list.length;
  if (limit) list = list.slice(0, Number(limit));
  return { total, markets: list };
}
async function healthView() {
  const [blockHex, chainIdHex] = await Promise.all([rpc('eth_blockNumber'), rpc('eth_chainId')]);
  const reg = Object.values(state.stockRegistry);
  return {
    ok: true, mode: 'custorium-exchange-v2', web3: true,
    chain: { chainId: Number(BigInt(chainIdHex)), chainIdHex, rpcProxy: '/api/rpc', nativeToken: 'CSTO', blockNumber: Number(BigInt(blockHex)), cosmosChainId: chain.cosmosChainId },
    custody: state.custody?.address ?? null,
    tokens: Object.fromEntries(Object.entries(tokenBySymbol).map(([s, t]) => [s, t.address])),
    decimals: Object.fromEntries(Object.entries(tokenBySymbol).map(([s, t]) => [s, t.decimals ?? 18])),
    listed: {
      stocks: reg.length,
      priced: reg.filter(x => x.price > 0).length,
      migrated: Object.keys(state.migratedStocks).length,
      providerFunded: !!state.stockProviderFunded,
      markets: marketByInstrument.size,
      explorer: EXPLORER,
    },
    oracle: chain.oracle.address,
    mm: mmEvm,
  };
}

const engine = createMatchingEngine();
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname, searchParams } = url;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) return staticFile(res, 'index.html');
    if (req.method === 'GET' && pathname.startsWith('/vendor/')) return staticFile(res, pathname.slice(1));

    if (req.method === 'POST' && pathname === '/api/rpc') return json(res, 200, await rpcProxy(await readBody(req)));

    if (pathname === '/api/health') return json(res, 200, await healthView());
    if (pathname === '/api/config') return json(res, 200, { ...(await healthView()), markets: marketsView({ limit: 50 }) });
    if (req.method === 'GET' && pathname === '/api/markets') {
      const q = searchParams.get('q');
      const limit = searchParams.get('limit');
      return json(res, 200, marketsView({ q, limit: limit ? Number(limit) : null }));
    }
    if (req.method === 'GET' && pathname === '/api/orderbook') {
      const instrument = searchParams.get('instrument') || 'XAUUSD';
      return json(res, 200, { orderbook: engine.getBook(instrument, { depth: 20 }) });
    }
    if (req.method === 'GET' && pathname === '/api/trades') {
      const instrument = searchParams.get('instrument');
      const list = (instrument ? state.trades.filter(t => t.instrument === instrument) : state.trades).slice(-50).reverse();
      return json(res, 200, { trades: list });
    }
    if (req.method === 'GET' && pathname === '/api/candles') {
      const instrument = searchParams.get('instrument') || 'XAUUSD';
      const interval = Math.min(Math.max(Number(searchParams.get('interval')) || 60, 5), 3600) * 1000;
      const list = state.trades.filter(t => t.instrument === instrument).sort((a, b) => a.timestamp - b.timestamp);
      const buckets = new Map();
      for (const t of list) {
        const b = Math.floor(t.timestamp / interval) * interval;
        const c = buckets.get(b);
        if (!c) buckets.set(b, { t: b, o: t.price, h: t.price, l: t.price, c: t.price, v: t.quantity });
        else { c.h = Math.max(c.h, t.price); c.l = Math.min(c.l, t.price); c.c = t.price; c.v += t.quantity; }
      }
      const candles = [...buckets.values()].sort((a, b) => a.t - b.t).slice(-300);
      return json(res, 200, { instrument, interval, candles });
    }
    if (req.method === 'GET' && pathname === '/api/account') return json(res, 200, { account: await accountView(searchParams.get('address')) });
    if (req.method === 'GET' && pathname === '/api/backing') return json(res, 200, await backingView());

    if (req.method === 'POST' && pathname === '/api/auth/challenge') {
      const b = await readBody(req);
      if (!isAddress(b.address)) throw new Error('valid address required');
      const nonce = `Custorium session ${Date.now().toString(36)} ${crypto.randomBytes(4).toString('hex')}`;
      challenges.set(nonce, { address: lower(b.address), exp: Date.now() + 5 * 60 * 1000 });
      return json(res, 200, { nonce });
    }
    if (req.method === 'POST' && pathname === '/api/auth/verify') {
      const b = await readBody(req);
      if (!isAddress(b.address)) throw new Error('valid address required');
      const ch = challenges.get(b.nonce);
      challenges.delete(b.nonce);
      if (!ch || ch.exp < Date.now()) throw new Error('challenge expired — try again');
      if (ch.address !== lower(b.address)) throw new Error('challenge address mismatch');
      const recovered = await ecrecoverAddress(b.nonce, b.sig);
      if (lower(recovered) !== lower(b.address)) throw new Error('signature does not match address');
      const token = newToken();
      sessions.set(token, { address: lower(b.address), exp: Date.now() + 30 * 60 * 1000 });
      return json(res, 200, { token, address: lower(b.address) });
    }

    if (req.method === 'POST' && pathname === '/api/faucet') {
      const b = await readBody(req);
      return json(res, 200, await enqueue(() => faucetFlow(b)));
    }
    if (req.method === 'POST' && pathname === '/api/orders') {
      const b = await readBody(req);
      authGuard(req, b);
      return json(res, 200, await enqueue(() => placeOrderFlow(b)));
    }
    if (req.method === 'POST' && pathname === '/api/orders/cancel') {
      const b = await readBody(req);
      authGuard(req, b);
      return json(res, 200, await enqueue(() => cancelOrderFlow(b)));
    }
    if (req.method === 'POST' && pathname === '/api/withdraw') {
      const b = await readBody(req);
      authGuard(req, b);
      return json(res, 200, await enqueue(() => withdrawFlow(b)));
    }
    if (req.method === 'POST' && pathname === '/api/convert') {
      const b = await readBody(req);
      authGuard(req, b);
      return json(res, 200, await enqueue(() => convertFlow(b)));
    }
    if (req.method === 'POST' && pathname === '/api/price') {
      const b = await readBody(req);
      const p = Number(b.price);
      if (!(p > 0)) throw new Error('price must be positive');
      const instrument = marketByInstrument.has(b.instrument) ? b.instrument : null;
      if (!instrument) throw new Error('unknown instrument');
      const receipt = await enqueue(() => pushPriceOnChain(instrument, p));
      marks.set(instrument, { price: p, ts: Date.now(), source: 'manual' });
      return json(res, 200, { instrument, price: p, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber });
    }

    if (req.method === 'POST' && pathname === '/api/prices') {
      // admin-only override for listed-token prices (the explorer's exchange_rate is the
      // default authority; the treasury can correct any mark here without an oracle tx)
      const b = await readBody(req);
      authGuard(req, b);
      if (lower(b.address) !== lower(adminEvm)) throw new Error('admin session required');
      const updates = Array.isArray(b.prices) ? b.prices : [{ instrument: b.instrument, price: b.price }];
      const applied = [];
      for (const u of updates) {
        const instrument = marketByInstrument.has(u.instrument) ? u.instrument : null;
        const p = Number(u.price);
        if (!instrument || !(p > 0)) continue;
        marks.set(instrument, { price: p, ts: Date.now(), source: 'admin' });
        if (state.stockRegistry[instrument]) { state.stockRegistry[instrument].price = p; saveState(); }
        applied.push({ instrument, price: p });
      }
      if (!applied.length) throw new Error('no valid {instrument, price} updates');
      return json(res, 200, { applied });
    }

    return json(res, 404, { error: 'not_found' });
  } catch (err) {
    return json(res, 400, { error: err?.message || String(err) });
  }
});

export { server };

// ---------------------------------------------------------------- startup
async function seedMarks() {
  for (const m of chain.markets) {
    try {
      const feed = await getFeedOnChain(m.instrument);
      if (feed && feed.price > 0n) {
        marks.set(m.instrument, { price: Number(feed.price) / 1e8, ts: feed.updatedAt, source: 'onchain-oracle' });
        continue;
      }
    } catch (e) { log(`feed read failed for ${m.instrument}: ${e.message}`); }
    if (FALLBACK_PRICES[m.instrument]) marks.set(m.instrument, { price: FALLBACK_PRICES[m.instrument], ts: Date.now(), source: 'fallback' });
  }
  // listed stock tokens: the explorer's exchange_rate (imported at registry sync) is the price authority
  let listed = 0;
  for (const [symbol, e] of Object.entries(state.stockRegistry)) {
    if (e.price > 0) { marks.set(symbol, { price: e.price, ts: Date.now(), source: 'listed' }); listed++; }
  }
  log(`marks: ${[...marks.entries()].filter(([k]) => !CORE_SYMBOLS.has(k) && k !== 'nUSD').length + 4} instruments seeded (${listed} listed from explorer)`);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  // wait for the chain instead of crashing — the devnet gets bounced during maintenance
  await (async function waitForChain(timeoutMs = 15 * 60 * 1000) {
    const start = Date.now();
    let logged = false;
    for (;;) {
      try { await rpc('eth_blockNumber'); return; }
      catch (e) {
        if (Date.now() - start > timeoutMs) fail(`chain RPC not reachable after 15 min: ${e.message}`);
        if (!logged) { log(`waiting for chain RPC (${RPC})…`); logged = true; }
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  })();
  // listed-token registry FIRST: rebuilds tokenBySymbol/marketByInstrument for all 539
  // stock tokens so seedMarks/keeper/backing see them from the very first tick
  await syncTokenRegistry();
  await initOracle();
  TRANSFER_TOPIC0 = '0x' + await keccak(TRANSFER_EVENT);
  await seedMarks();
  await bootstrapCustody();
  await depositWatcherTick(); // credit pre-existing custody inflows FIRST (e.g. mm inventory move)
  await syncInventory();      // THEN derive K = custody_on_chain - liabilities (correct order)
  server.listen(PORT, '127.0.0.1', () => {
    log(`Custorium Exchange v2 (real trading + Web3 wallet) at http://127.0.0.1:${PORT}`);
    log(`chain ${chain.cosmosChainId} | EVM ${chain.chainId} (${chain.chainIdHex}) | custody ${state.custody.address}`);
    log(`listed tokens: ${Object.keys(state.stockRegistry).length} stocks | markets: ${marketByInstrument.size}`);
  });
  setInterval(() => depositWatcherTick().catch(e => log(`watcher: ${e.message}`)), 3_000);
  setInterval(() => enqueue(keeperTick).catch(() => {}), 10_000);
  enqueue(keeperTick).catch(() => {});
  // background jobs for the listed-token layer
  fillListedPrices(100).catch(() => {});                                   // missing prices from the explorer
  setInterval(() => fillListedPrices(100).catch(() => {}), 30_000);        // (100 lookups per pass)
  setInterval(() => syncTokenRegistry().catch(() => {}), 10 * 60_000);     // re-discover new listings
  setInterval(() => reconcileCustodyBatch().catch(() => {}), 30_000);      // chain-verify custody cache
  const shutdown = () => { try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch {} process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (e) => log(`unhandled rejection (suppressed): ${e?.message || e}`));
}
