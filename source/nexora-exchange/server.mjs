#!/usr/bin/env node
/**
 * NEXORA Exchange v2 — REAL trading + self-custody Web3 wallet (TESTNET/DEVNET ONLY).
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
import { execFile } from 'node:child_process';
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
const GAS_PRICE = process.env.CHAIN_GAS_PRICE || '2000000000';
const publicDir = path.join(__dirname, 'public');

const ZERO32 = '0x' + '00'.repeat(32);
const W8 = 10n ** 8n;
const ECRECOVER = '0x0000000000000000000000000000000000000001';
const TRANSFER_EVENT = 'Transfer(address,address,uint256)';
const SELECTOR_BALANCE_OF = '0x70a08231';
const FAUCET_AMOUNTS = { nUSD: '10000', nXAU: '2', nBTC: '0.05', nEUR: '5000' };
const FAUCET_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12h per address
const DEFAULT_QTY = { XAUUSD: 5, BTCUSD: 0.5, EURUSD: 20000 };
const FALLBACK_PRICES = { XAUUSD: 2350, BTCUSD: 65000, EURUSD: 1.08 };

const log = (...a) => console.log('[nexora-exchange]', ...a);
const fail = (m) => { console.error('[nexora-exchange] FATAL:', m); process.exit(1); };

// ---------------------------------------------------------------- chain state
if (!fs.existsSync(CHAIN_STATE_PATH)) fail(`chain state missing (${CHAIN_STATE_PATH}) — run: node source/nexora-exchange/chain/bootstrap.mjs`);
const chain = JSON.parse(fs.readFileSync(CHAIN_STATE_PATH, 'utf8'));
const RPC = chain.rpc;
const tokenBySymbol = { ...chain.tokens };
const marketByInstrument = new Map(chain.markets.map(m => [m.instrument, m]));
const adminPk = chain.accounts.dev0.pk;
const mmPk = chain.accounts.mm.pk;
const mmEvm = chain.accounts.mm.evmAddress;
if (!fs.existsSync(CAST)) fail(`cast not found at ${CAST}`);

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
const toUnits = (raw) => Number(raw) / 1e18;
const raw18 = (units) => BigInt(Math.round(Number(units) * 1e18));
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
    if (o.side === 'buy' && symbol === 'nUSD') sum += o.price * o.remaining;
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

// ---------------------------------------------------------------- deposits watcher
let TRANSFER_TOPIC0 = null;
async function depositWatcherTick() {
  if (!state.custody || !TRANSFER_TOPIC0) return;
  let allOk = true;
  const head = await headNumber();
  const from = state.depositCursor == null ? 0 : state.depositCursor;
  const to = head - 1;
  if (to < from) return;
  for (const [symbol, token] of Object.entries(tokenBySymbol)) {
    let logs = [];
    try {
      logs = await rpc('eth_getLogs', [{
        address: token.address,
        topics: [TRANSFER_TOPIC0, null, '0x' + pad64(state.custody.address)],
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
      }]);
    } catch (e) { log(`getLogs ${symbol}: ${e.message}`); allOk = false; continue; }
    for (const lg of logs) {
      try {
        const key = `${lg.transactionHash}:${lg.logIndex ?? '0'}`;
        if (state.processedTxs[key]) continue; // idempotent: rescans never double-credit
        const fromAddr = '0x' + (lg.topics[1] || '').slice(-40);
        if (lower(fromAddr) === lower(state.custody.address)) continue; // ignore self
        // ERC20 Transfer: topic1=from, topic2=to, value in DATA (OpenZeppelin layout)
        const amount = BigInt(lg.data && lg.data !== '0x' ? lg.data : (lg.topics[3] || '0x0'));
        if (amount <= 0n) continue;
        const units = toUnits(amount);
        ledgerAdd(fromAddr, symbol, units);
        state.processedTxs[key] = true;
        state.deposits.push({
          txHash: lg.transactionHash, address: lower(fromAddr), symbol,
          amountRaw: amount.toString(), block: Number(BigInt(lg.blockNumber)), timestamp: Date.now(),
        });
        if (state.deposits.length > 2000) state.deposits.splice(0, state.deposits.length - 2000);
        log(`deposit credited: ${symbol} ${units} → ${fromAddr.slice(0, 10)}… (tx ${lg.transactionHash.slice(0, 14)}…)`);
      } catch (e) { log(`deposit log skipped: ${e.message}`); }
    }
  }
  if (allOk) { state.depositCursor = head; saveState(); }
}

// ---------------------------------------------------------------- settlement (ledger, CEX-style)
async function settleTrade(trade) {
  const buyer = lower(state.orders[trade.buyOrderId]?.address);
  const seller = lower(state.orders[trade.sellOrderId]?.address);
  const mk = marketByInstrument.get(trade.instrument);
  if (!mk || !buyer || !seller) throw new Error('settlement: missing order metadata');

  const notional = trade.price * trade.quantity;
  ledgerAdd(buyer, 'nUSD', -notional);
  ledgerAdd(buyer, mk.base, trade.quantity);
  ledgerAdd(seller, mk.base, -trade.quantity);
  ledgerAdd(seller, 'nUSD', notional);
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
    timestamp: trade.timestamp, buyer, seller,
    buyerOrderId: trade.buyOrderId, sellerOrderId: trade.sellOrderId,
  };
  state.trades.push(rec);
  if (state.trades.length > 1000) state.trades.splice(0, state.trades.length - 1000);
  return rec;
}

// ---------------------------------------------------------------- order flow
async function placeOrderFlow({ address, instrument, side, price, quantity }) {
  if (!isAddress(address)) throw new Error('valid wallet address required');
  const mk = marketByInstrument.get(instrument);
  if (!mk) throw new Error(`unknown instrument "${instrument}"`);
  if (side !== 'buy' && side !== 'sell') throw new Error('side must be buy or sell');
  price = Number(price); quantity = Number(quantity);
  if (!(price > 0) || !Number.isFinite(price)) throw new Error('price must be a positive number');
  if (!(quantity > 0) || !Number.isFinite(quantity)) throw new Error('quantity must be a positive number');

  const needSymbol = side === 'buy' ? 'nUSD' : mk.base;
  const need = side === 'buy' ? price * quantity : quantity;
  const av = ledgerAvailable(address, needSymbol);
  if (av.available < need - 1e-9) {
    throw new Error(`insufficient ${needSymbol} in trading account: balance ${av.balance.toFixed(4)}, locked ${av.locked.toFixed(4)}, free ${av.available.toFixed(4)}, need ${need} — deposit from your Web3 wallet first`);
  }

  const id = `ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const ts = Date.now();
  const result = engine.placeOrder({ id, instrument, side, price, quantity, accountId: lower(address), timestamp: ts });
  state.orders[id] = { id, address: lower(address), instrument, side, price, quantity, remaining: result.order.remaining, status: result.order.status, timestamp: ts };

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

// ---------------------------------------------------------------- keeper (mm liquidity)
let keeperBusy = false;
async function keeperTick() {
  if (keeperBusy) return;
  keeperBusy = true;
  try {
    for (const m of chain.markets) {
      const mark = markOf(m.instrument);
      if (!mark) continue;
      if (ledgerBalance(mmEvm, m.base) < 1 && ledgerBalance(mmEvm, 'nUSD') < mark) continue;
      const qty = DEFAULT_QTY[m.instrument] ?? 1;
      const tick = Math.max(mark < 10 ? 0.01 : 1, Math.round(mark * 0.002 * 100) / 100);
      const fmtPx = (p) => mark < 10 ? Math.round(p * 10000) / 10000 : Math.round(p * 100) / 100;
      for (const side of ['buy', 'sell']) {
        const openMm = Object.values(state.orders).filter(o =>
          lower(o.address) === lower(mmEvm) && o.instrument === m.instrument && o.side === side
          && (o.status === 'open' || o.status === 'partially_filled'));
        if (openMm.length >= 2) continue;
        const px = fmtPx(side === 'buy' ? mark - tick : mark + tick);
        try { await placeOrderFlow({ address: mmEvm, instrument: m.instrument, side, price: px, quantity: qty }); }
        catch { /* insufficient mm funds or book full — retry next tick */ }
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
  if (gas < 10n ** 18n) {
    const r = await castSend({ to: state.custody.address, from: adminPk, value: (10n ** 20n).toString() });
    log(`custody gas funded by dev0: 100 ANEX (tx ${r.transactionHash.slice(0, 14)}…)`);
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
  const balances = Object.keys(tokenBySymbol).map(symbol => {
    const av = ledgerAvailable(k, symbol);
    return { symbol, ...av };
  });
  const mark = {};
  for (const m of chain.markets) mark[m.base] = markOf(m.instrument);
  const cash = l.nUSD ?? 0;
  let equity = cash;
  const positions = [];
  for (const m of chain.markets) {
    const p = (state.positions[k] || {})[m.instrument];
    const bal = l[m.base] ?? 0;
    const upnl = (p && mark[m.base] != null) ? (mark[m.base] - p.avgPrice) * p.qty : null;
    if (mark[m.base] != null) equity += bal * mark[m.base];
    positions.push({
      instrument: m.instrument, base: m.base, qty: p?.qty ?? 0, avgPrice: p?.avgPrice ?? 0,
      markPrice: mark[m.base], unrealizedPnl: upnl, realizedPnl: p?.realizedPnl ?? 0, balance: bal,
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
  // gas first: a fresh wallet cannot even sign a transfer without native ANEX
  const gas = await nativeBalanceRaw(address);
  if (gas < 10n ** 17n) {
    const r = await castSend({ to: address, from: adminPk, value: (2n * 10n ** 18n).toString() });
    txs.ANEX = r.transactionHash;
    log(`faucet gas 2 ANEX → ${k.slice(0, 10)}… tx ${r.transactionHash.slice(0, 14)}…`);
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
    args: [to, raw18(amt).toString()], from: state.custody.pk,
  });
  ledgerAdd(address, symbol, -amt);
  const rec = { txHash: r.transactionHash, block: r.blockNumber, address: lower(address), symbol, amount: amt, to: lower(to), timestamp: Date.now() };
  state.withdrawals.push(rec);
  saveState();
  log(`withdraw ${symbol} ${amt} → ${lower(to).slice(0, 10)}… tx ${r.transactionHash.slice(0, 14)}…`);
  return rec;
}

async function convertFlow({ address, from, to, amount }) {
  const valid = { ...tokenBySymbol };
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
  ledgerAdd(address, from, -amt);
  ledgerAdd(address, to, out);
  const rec = { timestamp: Date.now(), address: lower(address), from, to, fromAmount: amt, toAmount: Number(out.toFixed(12)), rate: Number((priceFrom / priceTo).toFixed(8)), fee: FEE };
  state.converts.push(rec);
  if (state.converts.length > 1000) state.converts.splice(0, state.converts.length - 1000);
  saveState();
  return rec;
}
function symbolPrice(symbol) {
  if (symbol === 'nUSD') return 1;
  const m = chain.markets.find(x => x.base === symbol);
  return m ? markOf(m.instrument) : null;
}

// ---------------------------------------------------------------- backing proof
async function backingView() {
  const rows = [];
  for (const [symbol, token] of Object.entries(tokenBySymbol)) {
    const onChain = toUnits(await balanceOfRaw(token.address, state.custody.address));
    let liabilities = 0;
    for (const l of Object.values(state.ledger)) liabilities += l[symbol] ?? 0;
    rows.push({ symbol, custodyOnChain: onChain, liabilities: Number(liabilities.toFixed(6)), backed: onChain + 1e-9 >= liabilities });
  }
  return { custody: state.custody.address, rows, allBacked: rows.every(r => r.backed) };
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

function marketsView() {
  return chain.markets.map(m => {
    const mk = marks.get(m.instrument);
    return {
      symbol: m.instrument, base: m.base, quote: m.quote, name: `${tokenBySymbol[m.base]?.name ?? m.base} / nUSD`,
      assetClass: tokenBySymbol[m.base]?.assetClass ?? '',
      price: mk?.price ?? null, updatedAt: mk?.ts ?? null, priceSource: mk?.source ?? null,
    };
  });
}
async function healthView() {
  const [blockHex, chainIdHex] = await Promise.all([rpc('eth_blockNumber'), rpc('eth_chainId')]);
  return {
    ok: true, mode: 'nexora-exchange-v2', web3: true,
    chain: { chainId: Number(BigInt(chainIdHex)), chainIdHex, rpcProxy: '/api/rpc', nativeToken: 'ANEX', blockNumber: Number(BigInt(blockHex)), cosmosChainId: chain.cosmosChainId },
    custody: state.custody?.address ?? null,
    tokens: Object.fromEntries(Object.entries(tokenBySymbol).map(([s, t]) => [s, t.address])),
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
    if (pathname === '/api/config') return json(res, 200, { ...(await healthView()), markets: marketsView() });
    if (req.method === 'GET' && pathname === '/api/markets') return json(res, 200, { markets: marketsView() });
    if (req.method === 'GET' && pathname === '/api/orderbook') {
      const instrument = searchParams.get('instrument') || 'XAUUSD';
      return json(res, 200, { orderbook: engine.getBook(instrument, { depth: 20 }) });
    }
    if (req.method === 'GET' && pathname === '/api/trades') {
      const instrument = searchParams.get('instrument');
      const list = (instrument ? state.trades.filter(t => t.instrument === instrument) : state.trades).slice(-50).reverse();
      return json(res, 200, { trades: list });
    }
    if (req.method === 'GET' && pathname === '/api/account') return json(res, 200, { account: await accountView(searchParams.get('address')) });
    if (req.method === 'GET' && pathname === '/api/backing') return json(res, 200, await backingView());

    if (req.method === 'POST' && pathname === '/api/auth/challenge') {
      const b = await readBody(req);
      if (!isAddress(b.address)) throw new Error('valid address required');
      const nonce = `NEXORA session ${Date.now().toString(36)} ${crypto.randomBytes(4).toString('hex')}`;
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
  log('marks: ' + [...marks.entries()].map(([k, v]) => `${k}=${v.price}(${v.source})`).join(' '));
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  await initOracle();
  TRANSFER_TOPIC0 = '0x' + await keccak(TRANSFER_EVENT);
  await seedMarks();
  await bootstrapCustody();
  await depositWatcherTick();
  server.listen(PORT, '127.0.0.1', () => {
    log(`NEXORA Exchange v2 (real trading + Web3 wallet) at http://127.0.0.1:${PORT}`);
    log(`chain ${chain.cosmosChainId} | EVM ${chain.chainId} (${chain.chainIdHex}) | custody ${state.custody.address}`);
  });
  setInterval(() => depositWatcherTick().catch(e => log(`watcher: ${e.message}`)), 3_000);
  setInterval(() => enqueue(keeperTick).catch(() => {}), 10_000);
  enqueue(keeperTick).catch(() => {});
  const shutdown = () => { try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch {} process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (e) => log(`unhandled rejection (suppressed): ${e?.message || e}`));
}
