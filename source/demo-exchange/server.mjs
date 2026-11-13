#!/usr/bin/env node
/**
 * NEXORA demo exchange — CHAIN-BACKED mode (TESTNET/DEVNET ONLY).
 *
 * Unlike the earlier in-memory demo, this server is wired to the REAL local NEXORA
 * devnet (evmd, EVM chain 902024 / 0xdc388, RPC 127.0.0.1:8545) and to the REAL
 * on-chain contracts deployed by chain/bootstrap.mjs:
 *
 *   - AssetToken nUSD/nXAU/nBTC/nEUR  (real ERC20s on the devnet)
 *   - MockOracle                      (real on-chain price feed contract)
 *
 * Architecture mirrors real exchanges:
 *   matching      → off-chain (source/exchange/src/matching-engine.mjs)
 *   balances      → ON-CHAIN (eth_call balanceOf is the source of truth)
 *   deposits      → ON-CHAIN mint transactions (admin key, recorded with txHash)
 *   settlement    → ON-CHAIN ERC20 transfers per fill (quote + base, txHash recorded)
 *   price feeds   → ON-CHAIN MockOracle.pushPrice transactions
 *
 * Trading accounts (alice/bob/mm) hold test-only keys generated locally by the
 * bootstrap; keys never leave /tmp and are never exposed through the HTTP API.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createMatchingEngine } from '../exchange/src/matching-engine.mjs';

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname, '../..');

const CAST = process.env.CAST_BIN || path.join(WORKSPACE, '.foundry/versions/foundry-rs/foundry/v1.8.5/cast');
const STATE_PATH = process.env.CHAIN_STATE || '/tmp/opencode/demo-chain-state.json';
const PORT = Number(process.env.PORT || 4173);
const GAS_PRICE = process.env.CHAIN_GAS_PRICE || '2000000000'; // 2 gwei in anex base units
const publicDir = path.join(__dirname, 'public');

const ZERO32 = '0x' + '00'.repeat(32);
const W18 = 10n ** 18n;
const W8 = 10n ** 8n;
const SELECTOR_BALANCE_OF = '0x70a08231'; // balanceOf(address)
const SELECTOR_DECIMALS = '0x313ce567';   // decimals()

const log = (...a) => console.log('[chain-exchange]', ...a);
const fail = (m) => { console.error('[chain-exchange] FATAL:', m); process.exit(1); };

// ---------------------------------------------------------------- state file
if (!fs.existsSync(CAST)) fail(`cast binary not found at ${CAST} (run bootstrap first)`);
if (!fs.existsSync(STATE_PATH)) {
  fail(`chain state not found at ${STATE_PATH} — run: node source/demo-exchange/chain/bootstrap.mjs`);
}
const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
const RPC = state.rpc;
const tokenBySymbol = { ...state.tokens };
const marketByInstrument = new Map(state.markets.map(m => [m.instrument, m]));
const adminPk = state.accounts.dev0.pk;
const accounts = ['alice', 'bob', 'mm'].filter(n => state.accounts[n]?.pk && state.accounts[n]?.evmAddress);

const evmOf = (name) => {
  const a = state.accounts[name];
  if (!a?.evmAddress) throw new Error(`unknown demo account "${name}" (available: ${accounts.join(', ')})`);
  return a.evmAddress;
};
const pkOf = (name) => {
  const a = state.accounts[name];
  if (!a?.pk) throw new Error(`no key for account "${name}"`);
  return a.pk;
};

// ---------------------------------------------------------------- engine + memory
const engine = createMatchingEngine();
const orders = new Map();      // orderId -> {id, instrument, side, price, quantity, remaining, accountId, timestamp, status}
const enrichedTrades = [];     // settled trades with txHashes
const marks = new Map();       // instrument -> {price, ts, source}
const positions = new Map();   // account -> Map(instrument -> {qty, avgPrice, realizedPnl})

// ---------------------------------------------------------------- primitives
async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result;
}
const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

const pad64 = (hex) => String(hex).replace(/^0x/, '').padStart(64, '0');
const word = (hex, i) => hex.replace(/^0x/, '').slice(i * 64, i * 64 + 64);
const toUnits = (raw) => Number(raw) / 1e18;
const raw18 = (units) => BigInt(Math.round(Number(units) * 1e18));
const price8 = (units) => BigInt(Math.round(Number(units) * 1e8)); // oracle scale: 10^8 like Chainlink feeds

async function balanceOfRaw(token, evmAddress) {
  const data = SELECTOR_BALANCE_OF + pad64(evmAddress);
  const out = await ethCall(token, data);
  return BigInt(out === '0x' ? '0x0' : out);
}
const nativeBalanceRaw = (evmAddress) => rpc('eth_getBalance', [evmAddress, 'latest']).then((h) => BigInt(h));

async function castSend({ to, sig, args = [], from }) {
  const argv = ['send', to, sig, ...args, '--rpc-url', RPC, '--private-key', from, '--gas-price', GAS_PRICE, '--json'];
  let stdout;
  try {
    ({ stdout } = await exec(CAST, argv, { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 }));
  } catch (e) {
    const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join(' | ').slice(-500);
    throw new Error(`cast send ${sig} failed: ${detail}`);
  }
  const receipt = JSON.parse(stdout.trim());
  if (receipt.status !== '0x1') throw new Error(`tx reverted (${receipt.transactionHash || 'no hash'})`);
  return {
    transactionHash: receipt.transactionHash,
    blockNumber: Number(BigInt(receipt.blockNumber ?? '0x0')),
    gasUsed: Number(BigInt(receipt.gasUsed ?? '0x0')),
  };
}

// asset keys + oracle selector (computed once via cast, cached)
const assetKeys = new Map(); // instrument -> bytes32
let ORACLE_GET_PRICE = null;
function keccak(text) {
  return exec(CAST, ['keccak', text], { timeout: 15_000 }).then(r => r.stdout.trim());
}
async function initSelectors() {
  for (const m of state.markets) assetKeys.set(m.instrument, await keccak(m.instrument));
  const { stdout } = await exec(CAST, ['sig', 'getPrice(bytes32)'], { timeout: 15_000 });
  ORACLE_GET_PRICE = stdout.trim();
}

async function getFeedOnChain(instrument) {
  const key = assetKeys.get(instrument);
  if (!key || !ORACLE_GET_PRICE) return null;
  const out = await ethCall(state.oracle.address, ORACLE_GET_PRICE + pad64(key));
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
    to: state.oracle.address,
    sig: 'pushPrice(bytes32,uint256,uint8,bytes32)',
    args: [assetKeys.get(instrument), price8(priceUnits).toString(), '8', ZERO32],
    from: adminPk,
  });
}

// ---------------------------------------------------------------- locks (off-chain mirror of open orders)
function openLocksUnits(account, symbol) {
  let sum = 0;
  for (const o of orders.values()) {
    if (o.accountId !== account) continue;
    if (o.status !== 'open' && o.status !== 'partially_filled') continue;
    const mk = marketByInstrument.get(o.instrument);
    if (!mk) continue;
    if (o.side === 'buy' && symbol === 'nUSD') sum += o.price * o.remaining;
    if (o.side === 'sell' && symbol === mk.base) sum += o.remaining;
  }
  return sum;
}
async function available(account, symbol) {
  const token = tokenBySymbol[symbol];
  if (!token) throw new Error(`unknown token ${symbol}`);
  const balRaw = await balanceOfRaw(token.address, evmOf(account));
  const lockUnits = openLocksUnits(account, symbol);
  const lockRaw = raw18(lockUnits);
  const freeRaw = balRaw > lockRaw ? balRaw - lockRaw : 0n;
  return { symbol, balance: toUnits(balRaw), locked: lockUnits, available: toUnits(freeRaw) };
}

// ---------------------------------------------------------------- positions (off-chain analytics only)
function applyFillPositions(account, side, trade) {
  let pmap = positions.get(account);
  if (!pmap) { pmap = new Map(); positions.set(account, pmap); }
  const p = pmap.get(trade.instrument) || { qty: 0, avgPrice: 0, realizedPnl: 0 };
  const q = trade.quantity, price = trade.price;
  if (side === 'buy') {
    if (p.qty >= 0) {
      p.avgPrice = (p.avgPrice * p.qty + price * q) / (p.qty + q);
      p.qty += q;
    } else {
      const cover = Math.min(q, -p.qty);
      p.realizedPnl += (p.avgPrice - price) * cover; // closing short: profit when buy < avg
      p.qty += q;
      if (p.qty > 0) p.avgPrice = price;
    }
  } else {
    if (p.qty > 0) {
      const close = Math.min(q, p.qty);
      p.realizedPnl += (price - p.avgPrice) * close;
      p.qty -= q;
      if (p.qty < 0) p.avgPrice = price;
    } else if (p.qty === 0) {
      p.qty -= q;
      p.avgPrice = price;
    } else {
      p.avgPrice = (p.avgPrice * -p.qty + price * q) / (-p.qty + q);
      p.qty -= q;
    }
  }
  pmap.set(trade.instrument, p);
}

// ---------------------------------------------------------------- settlement (ON-CHAIN)
const FALLBACK_PRICES = { XAUUSD: 2350, BTCUSD: 65000, EURUSD: 1.08 };

async function settleTrade(trade) {
  const buyerMeta = orders.get(trade.buyOrderId);
  const sellerMeta = orders.get(trade.sellOrderId);
  const buyer = buyerMeta?.accountId ?? 'unknown';
  const seller = sellerMeta?.accountId ?? 'unknown';
  const mk = marketByInstrument.get(trade.instrument);
  if (!mk) throw new Error(`unknown market ${trade.instrument}`);

  const buyerEvm = evmOf(buyer);
  const sellerEvm = evmOf(seller);
  const baseRaw = raw18(trade.quantity);
  const notionalRaw = price8(trade.price) * baseRaw / W8; // nUSD wei, integer-exact

  // defensive on-chain re-check of the payer (locks already guaranteed this at placement)
  const buyerQuoteRaw = await balanceOfRaw(mk.quoteContract, buyerEvm);
  if (buyerQuoteRaw < notionalRaw) {
    throw new Error(`settlement aborted: buyer ${buyer} has ${toUnits(buyerQuoteRaw)} nUSD on-chain, needs ${toUnits(notionalRaw)}`);
  }

  const doQuoteSend = () => castSend({
    to: mk.quoteContract, sig: 'transfer(address,uint256)',
    args: [sellerEvm, notionalRaw.toString()], from: pkOf(buyer),
  });
  const doBaseSend = () => castSend({
    to: mk.baseContract, sig: 'transfer(address,uint256)',
    args: [buyerEvm, baseRaw.toString()], from: pkOf(seller),
  });
  const [txQuote, txBase] = buyerEvm.toLowerCase() === sellerEvm.toLowerCase()
    ? [await doQuoteSend(), await doBaseSend()] // same payer: serialize to avoid nonce races
    : await Promise.all([doQuoteSend(), doBaseSend()]);

  // sync off-chain mirrors
  for (const m of [buyerMeta, sellerMeta]) {
    if (!m) continue;
    m.remaining = Math.max(0, m.remaining - trade.quantity);
    m.status = m.remaining === 0 ? 'filled' : (m.remaining < m.quantity ? 'partially_filled' : m.status);
  }
  applyFillPositions(buyer, 'buy', trade);
  applyFillPositions(seller, 'sell', trade);

  return {
    id: trade.id,
    instrument: trade.instrument,
    price: trade.price,
    quantity: trade.quantity,
    timestamp: trade.timestamp,
    buyer, seller,
    buyerOrderId: trade.buyOrderId,
    sellerOrderId: trade.sellOrderId,
    settlement: {
      quote: { symbol: 'nUSD', amountRaw: notionalRaw.toString(), txHash: txQuote.transactionHash, blockNumber: txQuote.blockNumber },
      base: { symbol: mk.base, amountRaw: baseRaw.toString(), txHash: txBase.transactionHash, blockNumber: txBase.blockNumber },
    },
  };
}

// ---------------------------------------------------------------- serialized ops
let opChain = Promise.resolve();
function enqueue(fn) {
  const p = opChain.then(fn, fn);
  opChain = p.catch(() => {});
  return p;
}

async function placeOrderFlow({ account, instrument, side, price, quantity }) {
  const mk = marketByInstrument.get(instrument);
  if (!mk) throw new Error(`unknown instrument "${instrument}" (available: ${[...marketByInstrument.keys()].join(', ')})`);
  if (!accounts.includes(account)) throw new Error(`unknown trading account "${account}" (available: ${accounts.join(', ')})`);
  price = Number(price); quantity = Number(quantity);
  if (!(price > 0) || !Number.isFinite(price)) throw new Error('price must be a positive number');
  if (!(quantity > 0) || !Number.isFinite(quantity)) throw new Error('quantity must be a positive number');

  const needSymbol = side === 'buy' ? 'nUSD' : mk.base;
  const need = side === 'buy' ? price * quantity : quantity;
  const av = await available(account, needSymbol);
  if (av.available < need - 1e-9) {
    throw new Error(`insufficient ${needSymbol} on-chain for ${side}: balance ${av.balance.toFixed(4)}, locked ${av.locked.toFixed(4)}, free ${av.available.toFixed(4)}, need ${need}`);
  }

  const id = `ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const ts = Date.now();
  const result = engine.placeOrder({ id, instrument, side, price, quantity, accountId: account, timestamp: ts });
  const meta = {
    id, instrument, side, price, quantity,
    remaining: result.order.remaining, accountId: account, timestamp: ts, status: result.order.status,
  };
  orders.set(id, meta);

  const settled = [];
  try {
    for (const tr of result.trades) {
      const t = await settleTrade(tr);
      settled.push(t);
      enrichedTrades.push(t);
    }
  } catch (e) {
    // engine state is authoritative for matching; resync our mirror before surfacing the error
    const cur = engine.getOrder(id);
    if (cur) { meta.status = cur.status; meta.remaining = cur.remaining; }
    throw e;
  }
  meta.status = engine.getOrder(id)?.status ?? result.order.status;
  meta.remaining = engine.getOrder(id)?.remaining ?? meta.remaining;

  if (settled.length) {
    const last = settled[settled.length - 1];
    marks.set(instrument, { price: last.price, ts: last.timestamp, source: 'trade' });
    // best-effort oracle push — routed through the op queue so dev0-keyed txs never race on nonce
    enqueue(() => pushPriceOnChain(instrument, last.price)).catch((e) => log(`oracle push skipped: ${e.message}`));
  }
  return { order: { ...meta }, trades: settled };
}

async function cancelOrderFlow(orderId) {
  const out = engine.cancelOrder(String(orderId));
  const meta = orders.get(String(orderId));
  if (meta) meta.status = 'cancelled';
  return { order: meta ? { ...meta } : out };
}

async function depositFlow({ account, symbol, amount }) {
  if (!accounts.includes(account)) throw new Error(`unknown trading account "${account}"`);
  const token = tokenBySymbol[symbol];
  if (!token) throw new Error(`unknown token "${symbol}" (available: ${Object.keys(tokenBySymbol).join(', ')})`);
  const amt = Number(amount);
  if (!(amt > 0) || !Number.isFinite(amt)) throw new Error('amount must be a positive number');
  const receipt = await castSend({
    to: token.address, sig: 'mint(address,uint256)',
    args: [evmOf(account), raw18(amt).toString()], from: adminPk,
  });
  const bal = await balanceOfRaw(token.address, evmOf(account));
  return { account, symbol, amount: amt, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber, balance: toUnits(bal) };
}

async function setMarkFlow({ instrument, price }) {
  const p = Number(price);
  if (!(p > 0) || !Number.isFinite(p)) throw new Error('price must be a positive number');
  const receipt = await pushPriceOnChain(instrument, p);
  marks.set(instrument, { price: p, ts: Date.now(), source: 'manual' });
  const feed = await getFeedOnChain(instrument);
  return {
    instrument, price: p, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber,
    feed: feed ? { price: Number(feed.price) / 1e8, decimals: feed.decimals, fresh: feed.fresh } : null,
  };
}

async function portfolioFlow(account) {
  const evm = evmOf(account);
  const balances = [];
  for (const [sym, t] of Object.entries(tokenBySymbol)) {
    balances.push({ symbol: sym, contract: t.address, units: toUnits(await balanceOfRaw(t.address, evm)) });
  }
  const gasUnits = toUnits(await nativeBalanceRaw(evm));
  const cash = balances.find(b => b.symbol === 'nUSD')?.units ?? 0;
  const pos = [];
  let equity = cash;
  for (const m of state.markets) {
    const mark = markOf(m.instrument);
    const p = positions.get(account)?.get(m.instrument);
    const onChain = balances.find(b => b.symbol === m.base)?.units ?? 0;
    const upnl = (mark != null && p) ? (mark - p.avgPrice) * p.qty : null;
    if (mark != null) equity += onChain * mark;
    pos.push({
      instrument: m.instrument, base: m.base,
      qty: p?.qty ?? 0, avgPrice: p?.avgPrice ?? 0, markPrice: mark,
      unrealizedPnl: upnl, realizedPnl: p?.realizedPnl ?? 0, onChainBalance: onChain,
    });
  }
  return { accountId: account, address: evm, gas: { symbol: 'ANEX', units: gasUnits }, cash: { symbol: 'nUSD', units: cash }, balances, positions: pos, equity };
}

function markOf(instrument) { return marks.get(instrument)?.price ?? null; }

// ---------------------------------------------------------------- market maker liquidity keeper
const DEFAULT_QTY = { XAUUSD: 5, BTCUSD: 0.5, EURUSD: 20000 };
let keeperBusy = false;async function keeperTick() {
  if (keeperBusy) return;
  keeperBusy = true;
  try {
    for (const m of state.markets) {
      const mark = markOf(m.instrument);
      if (!mark) continue;
      const qty = DEFAULT_QTY[m.instrument] ?? 1;
      const tick = Math.max(mark < 10 ? 0.01 : 1, Math.round(mark * 0.002 * 100) / 100);
      const pxOf = (side) => side === 'buy' ? mark - tick : mark + tick;
      const fmtPx = (p) => mark < 10 ? Math.round(p * 10000) / 10000 : Math.round(p * 100) / 100;
      for (const side of ['buy', 'sell']) {
        const openMm = [...orders.values()].filter(o =>
          o.accountId === 'mm' && o.instrument === m.instrument && o.side === side
          && (o.status === 'open' || o.status === 'partially_filled'));
        if (openMm.length >= 2) continue;
        const px = fmtPx(pxOf(side));
        try {
          await placeOrderFlow({ account: 'mm', instrument: m.instrument, side, price: px, quantity: qty });
          log(`keeper: mm ${side} ${m.instrument} @ ${px} x ${qty}`);
        } catch (e) {
          log(`keeper: skipped mm ${side} ${m.instrument}: ${e.message}`);
        }
      }
    }
  } finally {
    keeperBusy = false;
  }
}

// ---------------------------------------------------------------- http
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
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');

function marketsView() {
  return state.markets.map(m => {
    const mark = marks.get(m.instrument);
    return {
      symbol: m.instrument, base: m.base, quote: m.quote,
      baseContract: m.baseContract, quoteContract: m.quoteContract,
      name: `${state.tokens[m.base]?.name ?? m.base} / ${m.quote}`,
      assetClass: state.tokens[m.base]?.assetClass ?? '',
      price: mark?.price ?? null, updatedAt: mark?.ts ?? null, priceSource: mark?.source ?? null,
    };
  });
}

async function healthView() {
  const [blockHex, chainIdHex] = await Promise.all([rpc('eth_blockNumber'), rpc('eth_chainId')]);
  return {
    ok: true,
    mode: 'chain-backed-demo',
    chain: {
      chainId: Number(BigInt(chainIdHex)), chainIdHex,
      rpc: RPC, nativeToken: { symbol: 'ANEX', denom: 'anex' },
      blockNumber: Number(BigInt(blockHex)),
      cosmosChainId: state.cosmosChainId,
    },
    contracts: {
      quote: { symbol: 'nUSD', address: tokenBySymbol.nUSD.address },
      base: { nXAU: tokenBySymbol.nXAU.address, nBTC: tokenBySymbol.nBTC.address, nEUR: tokenBySymbol.nEUR.address },
      oracle: state.oracle.address,
    },
    accounts: accounts.map(a => ({ name: a, address: shortAddr(evmOf(a)) })),
    deployedAt: state.deployedAt,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname, searchParams } = url;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(publicDir, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (pathname === '/api/health') return json(res, 200, await healthView());
    if (req.method === 'GET' && pathname === '/api/markets') return json(res, 200, { markets: marketsView() });
    if (req.method === 'GET' && pathname === '/api/orderbook') {
      const instrument = searchParams.get('instrument') || 'XAUUSD';
      return json(res, 200, { orderbook: engine.getBook(instrument, { depth: 20 }) });
    }
    if (req.method === 'GET' && pathname === '/api/trades') {
      const instrument = searchParams.get('instrument') || undefined;
      const list = (instrument ? enrichedTrades.filter(t => t.instrument === instrument) : enrichedTrades)
        .slice(-50).reverse().map(t => ({
          ...t,
          settlement: {
            quote: { ...t.settlement.quote, txHashShort: shortHash(t.settlement.quote.txHash) },
            base: { ...t.settlement.base, txHashShort: shortHash(t.settlement.base.txHash) },
          },
        }));
      return json(res, 200, { trades: list });
    }
    if (req.method === 'GET' && pathname === '/api/portfolio') {
      return json(res, 200, { portfolio: await portfolioFlow(searchParams.get('account') || 'alice') });
    }
    if (req.method === 'GET' && pathname === '/api/network') return json(res, 200, await healthView());

    if (req.method === 'POST' && pathname === '/api/deposit') {
      const b = await readBody(req);
      return json(res, 200, await enqueue(() => depositFlow(b)));
    }
    if (req.method === 'POST' && pathname === '/api/price') {
      const b = await readBody(req);
      return json(res, 200, await enqueue(() => setMarkFlow(b)));
    }
    if (req.method === 'POST' && pathname === '/api/orders') {
      const b = await readBody(req);
      return json(res, 200, await enqueue(() => placeOrderFlow({
        account: b.account || 'alice',
        instrument: b.instrument || 'XAUUSD',
        side: b.side,
        price: b.price,
        quantity: b.quantity,
      })));
    }
    if (req.method === 'POST' && pathname === '/api/orders/cancel') {
      const b = await readBody(req);
      return json(res, 200, await enqueue(() => cancelOrderFlow(b.orderId)));
    }

    return json(res, 404, { error: 'not_found' });
  } catch (err) {
    return json(res, 400, { error: err?.message || String(err) });
  }
});

export { server };

// ---------------------------------------------------------------- startup
async function seedMarks() {
  for (const m of state.markets) {
    try {
      const feed = await getFeedOnChain(m.instrument);
      if (feed && feed.price > 0n) {
        const wholePrice = Number(feed.price) / 1e8; // oracle decimals = 8
        marks.set(m.instrument, { price: wholePrice, ts: feed.updatedAt, source: 'onchain-oracle' });
        continue;
      }
    } catch (e) { log(`oracle feed unavailable for ${m.instrument}: ${e.message}`); }
    if (FALLBACK_PRICES[m.instrument]) {
      marks.set(m.instrument, { price: FALLBACK_PRICES[m.instrument], ts: Date.now(), source: 'fallback' });
    }
  }
  log('mark prices:', [...marks.entries()].map(([k, v]) => `${k}=${v.price}(${v.source})`).join(' '));
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  await initSelectors();
  await seedMarks();
  server.listen(PORT, '127.0.0.1', () => {
    log(`NEXORA chain-backed demo exchange running at http://127.0.0.1:${PORT}`);
    log(`chain: ${state.cosmosChainId} | EVM ${state.chainId} (${state.chainIdHex}) | RPC ${RPC}`);
    log(`quote: nUSD ${tokenBySymbol.nUSD.address} | oracle: ${state.oracle.address}`);
  });
  setInterval(() => enqueue(keeperTick).catch(() => {}), 12_000);
  enqueue(keeperTick).catch(() => {});
  // last-resort resilience for the demo server: log instead of crashing the whole demo
  process.on('unhandledRejection', (e) => log(`unhandled rejection (suppressed): ${e?.message || e}`));
}
