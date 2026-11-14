import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.PRICE_PORT || 4100);
const GRABBER = '/home/runner/workspace/tools/web_data_grabber.mjs';
const ASSETS_CSV = '/home/runner/workspace/nexora-plan/assets/assets.csv';
const DEPLOYMENTS = '/home/runner/workspace/nexora-plan/token_deployments.jsonl';
const OUT = '/home/runner/workspace/nexora-plan/token_prices.json';
const CSTO_USD = Number(process.env.CSTO_USD || 3.0); // reference per agreement

const STOCK_CATS = new Set(['Stocks', 'ETFs', 'Global Equities', 'Global ETFs']);

// ---------------------------------------------------------------- bounded outbound pool
// global concurrency + per-host pacing: 3000 assets must price in ~60s without
// hammering any single source into rate-limiting us
const HOST_INTERVAL = { 'query1.finance.yahoo.com': 90, 'query2.finance.yahoo.com': 90, 'api.coingecko.com': 250 };
class Pool {
  constructor(conc = 16) { this.conc = conc; this.next = 0; this.lastByHost = new Map(); }
  async run(items, worker) {
    const results = new Array(items.length);
    this.next = 0; // per-run cursor — the pool instance is reused every refresh cycle
    const runners = Array.from({ length: Math.min(this.conc, Math.max(items.length, 1)) }, async () => {
      for (;;) {
        const i = this.next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]);
      }
    });
    await Promise.all(runners);
    return results;
  }
  async paced(host) {
    const min = HOST_INTERVAL[host] || 0;
    if (!min) return;
    for (;;) {
      const last = this.lastByHost.get(host) || 0;
      const wait = last + min - Date.now();
      if (wait <= 0) { this.lastByHost.set(host, Date.now()); return; }
      await new Promise(r => setTimeout(r, wait));
    }
  }
}
const pool = new Pool(Number(process.env.PRICE_CONCURRENCY || 16));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function fetchJSON(url, { tries = 3, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = async (n) => {
      const host = new URL(url).host;
      await pool.paced(host);
      const req = (url.startsWith('https') ? https : http).get(url, {
        headers: { 'user-agent': 'custorium-price-oracle/2.0', 'accept': 'application/json,text/plain,*/*' },
        timeout: timeoutMs,
      }, res => {
        let d = '';
        res.on('data', c => { d += c; if (d.length > 8e6) { req.destroy(new Error('response too large')); } });
        res.on('end', () => {
          if (res.statusCode === 429 || res.statusCode >= 500) {
            const ra = Number(res.headers['retry-after']) * 1000;
            const wait = Math.min(30000, ra > 0 ? ra : 800 * 2 ** (tries - n));
            if (n > 1) return sleep(wait).then(() => attempt(n - 1)).catch(reject);
            return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          }
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => { if (n > 1) sleep(800).then(() => attempt(n - 1)).catch(reject); else reject(e); });
    };
    attempt(tries).catch(reject);
  });
}

// ---------------------------------------------------------------- helpers
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  return lines.slice(1).map(line => { const cols = line.split(','); const o = {}; header.forEach((h, i) => o[h] = cols[i] ?? ''); return o; });
}

const fiatIds = new Set(['USD','EUR','JPY','CNY','GBP','CHF','CAD','AUD','NZD','HKD','SGD','SEK','NOK','DKK','PLN','CZK','HUF','RON','BGN','TRY','ZAR','BRL','MXN','INR','KRW','IDR','MYR','THB','PHP','VND','ILS','SAR','AED','QAR','KWD','BHD','OMR','JOD','EGP','MAD','NGN','KES','GHS','PKR','BDT','LKR','NPR','MMK','KHR','LAK','MNT','KZT','UZS','UAH','RUB','GEL','AMD','AZN','BYN','MDL','RSD','MKD','ALL','BAM','ISK','HRK','TWD','CLP','COP','PEN','ARS','UYU','PYG','BOB','VES','CRC','DOP','GTQ','HNL','NIO','PAB','JMD','TTD','BBD','BSD','BZD','XCD','HTG','GYD','SRD','AWG','ANG','CUP','FJD','PGK','SBD','TOP','WST','VUV','XPF']);

const cryptoMap = { // common mappings
  BTC:'bitcoin', ETH:'ethereum', BNB:'binancecoin', SOL:'solana', XRP:'ripple', ADA:'cardano', DOGE:'dogecoin', TRX:'tron', TON:'the-open-network', LINK:'chainlink', AVAX:'avalanche-2', SHIB:'shiba-inu', DOT:'polkadot', BCH:'bitcoin-cash', LTC:'litecoin', UNI:'uniswap', ATOM:'cosmos', XLM:'stellar', XMR:'monero', ETC:'ethereum-classic', HBAR:'hedera-hashgraph', APT:'aptos', FIL:'filecoin', NEAR:'near', ARB:'arbitrum', OP:'optimism', VET:'vechain', ICP:'internet-computer', ALGO:'algorand', MATIC:'matic-network', POL:'matic-network', STX:'blockstack', IMX:'immutable-x', INJ:'injective-protocol', RENDER:'render-token', GRT:'the-graph', FTM:'fantom', SAND:'the-sandbox', MANA:'decentraland', THETA:'theta-token', AAVE:'aave', EOS:'eos', MKR:'maker', SNX:'havven', FLOW:'flow', XTZ:'tezos', KAVA:'kava', NEO:'neo', IOTA:'iota', ZEC:'zcash', DASH:'dash', COMP:'compound-governance-token', CRV:'curve-dao-token', SUSHI:'sushi', YFI:'yearn-finance', '1INCH':'1inch', ENS:'ethereum-name-service', LDO:'lido-dao', PEPE:'pepe', WIF:'dogwifcoin', BONK:'bonk', FLOKI:'floki', RNDR:'render-token'
};

// ---------------------------------------------------------------- sources
async function fetchFx() {
  // primary + fallback (ECB daily via frankfurter) — a dead FX source must never blank 101 fiat tokens
  try { const d = await fetchJSON('https://api.exchangerate-api.com/v4/latest/USD'); if (d.rates) return { rates: d.rates, provider: 'exchangerate-api' }; } catch {}
  try { const d = await fetchJSON('https://api.frankfurter.dev/v1/latest?base=USD'); if (d.rates) return { rates: { ...d.rates, USD: 1 }, provider: 'frankfurter-ecb' }; } catch {}
  return { rates: {}, provider: 'none' };
}

async function fetchCryptoPrices() {
  const ids = [...new Set(Object.values(cryptoMap))];
  const out = {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100).join(','));
  const results = await Promise.allSettled(chunks.map(chunk =>
    fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(chunk)}&vs_currencies=usd`)));
  for (const r of results) if (r.status === 'fulfilled') for (const [id, v] of Object.entries(r.value || {})) out[id] = v.usd;
  return out;
}

function yahooSymbol(sym) {
  if (sym === 'BRK.B') return 'BRK-B';
  if (sym === 'BRK.A') return 'BRK-A';
  return sym; // keep dots for many international tickers like 0700.HK, 2222.SR, .NS, .L, .T
}

/** Yahoo v8 chart (the only unauthenticated Yahoo endpoint): global pool, host alternation, 429-aware */
async function fetchYahoo(symbols, log) {
  const out = {}, fails = { throttled: 0, other: 0 };
  const unique = [...new Set(symbols)];
  let seq = 0;
  await pool.run(unique, async (sym) => {
    // alternate query1/query2 — two rate buckets instead of one (both paced 90ms)
    const host = (seq++ % 2) ? 'query2.finance.yahoo.com' : 'query1.finance.yahoo.com';
    try {
      const d = await fetchJSON(`https://${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol(sym))}?interval=1d&range=1d`, { tries: 2 });
      const meta = d?.chart?.result?.[0]?.meta;
      const p = meta?.regularMarketPrice ?? meta?.previousClose ?? meta?.chartPreviousClose;
      if (p != null && isFinite(Number(p))) out[sym] = Number(p);
      else fails.other++;
    } catch (e) {
      if (String(e.message).includes('HTTP 429')) fails.throttled++;
      else fails.other++;
    }
  });
  return { out, fails };
}

async function fetchMetals() {
  try {
    const d = await fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids=tether-gold,pax-gold,kinesis-silver&vs_currencies=usd');
    return { XAU: d['tether-gold']?.usd || d['pax-gold']?.usd || null, XAG: d['kinesis-silver']?.usd || null };
  } catch { return {}; }
}

const CG_GRAB = '/home/runner/workspace/nexora-plan/grab_expand_crypto.json';
async function fetchCgMarkets() {
  const map = {};
  const pages = [1, 2, 3, 4, 5, 6, 7, 8];
  const results = await Promise.allSettled(pages.map(p =>
    fetchJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}&sparkline=false`)));
  let got = 0;
  for (const r of results) { // sequential trim: stop at first failure/short page
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) break;
    for (const c of r.value) { map[c.symbol?.toUpperCase()] = Number(c.current_price); got++; }
    if (r.value.length < 250) break;
  }
  if (got) return map;
  try { // offline fallback: last bulk grab
    if (fs.existsSync(CG_GRAB)) {
      const d = JSON.parse(fs.readFileSync(CG_GRAB, 'utf8'));
      for (const page of d) for (const c of (page.data || [])) map[c.symbol.toUpperCase()] = Number(c.current_price);
    }
  } catch {}
  return map;
}

function loadDeployments() {
  const map = {}; // symbol+category -> address
  if (!fs.existsSync(DEPLOYMENTS)) return map;
  for (const line of fs.readFileSync(DEPLOYMENTS, 'utf8').split(/\n/)) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.token && r.note !== 'duplicate_reconciled') map[`${r.category}|${r.symbol}`] = r; } catch {}
  }
  return map;
}

function refPrice(cat, sym) {
  if (cat === 'Real Estate') { return 3500; } // per sqm equivalent reference
  if (cat === 'Agriculture Commodities') { return { WHEAT:220, RICE:500, CORN:180, SOYBE:420, COFF:3500, COCO:4500, SUGA:400, COTT:85, PALM:900 }[sym.slice(3,7)] || 300; }
  if (cat === 'Carbon Credits') { return 45; }
  if (cat === 'Infrastructure') { return 1000; }
  if (cat === 'Art & Collectibles') { return 250; }
  if (cat === 'Intellectual Property') { return 50; }
  if (cat === 'Private Credit') { return 100; }
  if (cat === 'Insurance Linked') { return 100; }
  if (cat === 'Natural Resources') { return 120; }
  if (cat === 'Bonds') { return 98.5; }
  return null;
}

const validPrice = (p) => p != null && isFinite(Number(p)) && Number(p) > 0;

// ---------------------------------------------------------------- refresh cycle
let cache = null;            // served payload
let lastGood = {};           // symbol+category -> {price_usd, updated_at, source} — survive failed cycles & restarts (seeded from OUT)
let lastStats = { durationMs: 0, at: null, sources: {}, fails: {}, stale: 0, suspicious: 0 };

async function computePrices() {
  const t0 = Date.now();
  const assets = parseCSV(fs.readFileSync(ASSETS_CSV, 'utf8'));
  const deps = loadDeployments();

  // seed carry-forward from the last file (first cycle after a restart keeps prices fresh)
  if (!Object.keys(lastGood).length && fs.existsSync(OUT)) {
    try { const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      for (const [k, p] of Object.entries(prev.prices || {})) if (validPrice(p.price_usd)) lastGood[k] = { price_usd: p.price_usd, updated_at: p.updated_at, source: p.source };
    } catch {}
  }

  const stockSyms = assets.filter(a => STOCK_CATS.has(a.category)).map(a => a.symbol);
  const [fxRes, cryptoPrices, cgMarkets, metals, yahoo] = await Promise.all([
    fetchFx(), fetchCryptoPrices(), fetchCgMarkets(), fetchMetals(), fetchYahoo(stockSyms),
  ]);

  const prices = {};
  let stale = 0, suspicious = 0;
  const sources = {};
  for (const a of assets) {
    const key = `${a.category}|${a.symbol}`;
    const dep = deps[key];
    let usd = null, source = 'none';
    if (a.category === 'Fiat Currencies') {
      if (a.symbol === 'USD') usd = 1;
      else if (fxRes.rates[a.symbol]) usd = 1 / fxRes.rates[a.symbol];
      source = `fx:${fxRes.provider}`;
    } else if (a.category === 'Crypto Assets') {
      const symU = a.symbol.toUpperCase();
      const alt = symU.replace(/^CG-/, '');
      if (cgMarkets[symU] != null) { usd = cgMarkets[symU]; source = 'coingecko-market'; }
      else if (cgMarkets[alt] != null) { usd = cgMarkets[alt]; source = 'coingecko-market'; }
      else if (cryptoMap[symU] && cryptoPrices[cryptoMap[symU]] != null) { usd = cryptoPrices[cryptoMap[symU]]; source = 'coingecko'; }
    } else if (cryptoMap[a.symbol] && cryptoPrices[cryptoMap[a.symbol]] != null) {
      usd = cryptoPrices[cryptoMap[a.symbol]]; source = 'coingecko';
    } else if (STOCK_CATS.has(a.category) && yahoo.out[a.symbol] != null) {
      usd = yahoo.out[a.symbol]; source = 'yahoo';
    } else if (a.category === 'Metals' && metals[a.symbol] != null) {
      usd = metals[a.symbol]; source = 'commodity-proxy';
    } else if (a.category === 'Metals') {
      const m = { HG:4.5, NI:17000, AL:2500, ZN:2800, PB:2100, SN:32000, URX:85, LITH:12, COB:28000 };
      if (m[a.symbol]) { usd = m[a.symbol]; source = 'reference-commodity'; }
    } else if (a.category === 'Energy Assets') {
      const e = { BRNT:85, WTI:80, NGHH:2.2, NGTTF:9, 'LNG-G':10, RBOB:2.4, 'HO-F':2.5, 'URA-U':85, THERM:110, API2:100, NEWC:130, 'IRONE':110, 'LITH-C':12, COBALT:28000 };
      if (e[a.symbol]) { usd = e[a.symbol]; source = 'reference-energy'; }
    } else if (a.category === 'Bonds') {
      usd = 98.5; source = 'reference-bond-market';
    } else if (a.category === 'Hedge Funds') {
      usd = 1; source = 'reference-aum-usd';
    }
    if (usd == null) {
      const r = refPrice(a.category, a.symbol);
      if (r != null) { usd = r; source = 'reference-' + a.category.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
    }

    // quality: validate, carry last-good on failure, flag implausible moves
    let staleSince = null, isSuspicious = false;
    const prev = lastGood[key];
    if (!validPrice(usd)) {
      if (prev) { usd = prev.price_usd; source = `${source || 'none'}→carried:${prev.source}`; staleSince = prev.updated_at; stale++; }
    } else if (prev && Math.abs(Number(usd) / prev.price_usd - 1) > 0.6) {
      isSuspicious = true; suspicious++; // recorded, but flagged for review
    }
    if (validPrice(usd)) lastGood[key] = { price_usd: usd, updated_at: new Date().toISOString(), source };
    sources[source] = (sources[source] || 0) + 1;

    prices[key] = {
      symbol: a.symbol, name: a.name, category: a.category,
      price_usd: validPrice(usd) ? Number(usd) : null,
      token_address: dep?.token || null,
      decimals: Number(a.decimals_suggested || 0),
      source, updated_at: new Date().toISOString(),
      ...(staleSince ? { stale: true, stale_since: staleSince } : {}),
      ...(isSuspicious ? { suspicious: true } : {}),
    };
  }
  prices['Native|CSTO'] = { symbol: 'CSTO', name: 'Custorium', category: 'Native', price_usd: CSTO_USD, token_address: null, decimals: 18, source: 'reference', updated_at: new Date().toISOString() };
  sources['reference-native'] = 1;

  lastStats = { durationMs: Date.now() - t0, at: new Date().toISOString(), sources, fails: yahoo.fails, stale, suspicious };

  const payload = { updated_at: new Date().toISOString(), csto_usd: CSTO_USD, count: Object.keys(prices).length, prices };
  // atomic write — the blockscout sync must never read a half-written file
  const tmp = `${OUT}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, OUT);
  return payload;
}

async function refresh() {
  const t0 = Date.now();
  try {
    cache = await computePrices();
    console.log('prices updated', cache.updated_at, cache.count, `(${Date.now() - t0}ms, stale ${lastStats.stale}, suspicious ${lastStats.suspicious})`);
  } catch (e) { console.error('refresh error', e.message); }
}

const startedAt = Date.now();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  if (!cache && fs.existsSync(OUT)) { try { cache = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {} }
  if (url.pathname === '/health') {
    return res.end(JSON.stringify({ ok: true, updated_at: cache?.updated_at, count: cache?.count, uptime_s: Math.round((Date.now() - startedAt) / 1000), last_refresh: lastStats }));
  }
  if (url.pathname === '/prices') { if (!cache) await refresh(); return res.end(JSON.stringify(cache || {})); }
  if (url.pathname === '/price') {
    const sym = url.searchParams.get('symbol');
    if (!cache) await refresh();
    const matches = cache ? Object.values(cache.prices || {}).filter(p => p.symbol === sym) : [];
    return res.end(JSON.stringify({ symbol: sym, matches }));
  }
  if (url.pathname === '/token') {
    const addr = (url.searchParams.get('address') || '').toLowerCase();
    if (!cache) await refresh();
    const match = cache ? Object.values(cache.prices || {}).find(p => (p.token_address || '').toLowerCase() === addr) : null;
    return res.end(JSON.stringify(match || null));
  }
  // CoinGecko-compatible endpoints for Blockscout native coin (CSTO)
  if (url.pathname === '/api/v3/coins/list' || url.pathname === '/coins/list') {
    return res.end(JSON.stringify([{ id: 'custorium', symbol: 'csto', name: 'Custorium' }]));
  }
  if (url.pathname === '/api/v3/coins/custorium' || url.pathname === '/coins/custorium') {
    const price = cache?.csto_usd ?? CSTO_USD;
    const mc = 100000000000 * price;
    return res.end(JSON.stringify({
      id: 'custorium', symbol: 'csto', name: 'Custorium',
      image: { small: '', thumb: '' },
      market_data: {
        current_price: { usd: price },
        market_cap: { usd: mc },
        total_volume: { usd: 0 },
        circulating_supply: 100000000000,
        total_supply: 100000000000,
        last_updated: new Date().toISOString(),
      },
    }));
  }
  if (url.pathname === '/api/v3/coins/custorium/market_chart' || url.pathname === '/coins/custorium/market_chart') {
    const days = Math.max(1, Number(url.searchParams.get('days') || 1));
    const price = cache?.csto_usd ?? CSTO_USD;
    const now = Date.now();
    const pricesArr = [];
    for (let i = days; i >= 0; i--) pricesArr.push([now - i * 86400000, price]);
    return res.end(JSON.stringify({ prices: pricesArr, market_caps: pricesArr.map(p => [p[0], 100000000000 * price]), total_volumes: pricesArr.map(p => [p[0], 0]) }));
  }
  if (url.pathname.startsWith('/api/v3/simple/token_price/') || url.pathname.startsWith('/simple/token_price/')) {
    return res.end(JSON.stringify({}));
  }
  res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
});
server.listen(PORT, '0.0.0.0', () => { console.log('price oracle on', PORT); refresh(); setInterval(refresh, 5 * 60 * 1000); });

const shutdown = () => { try { if (cache) fs.writeFileSync(OUT, JSON.stringify(cache, null, 2)); } catch {} server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => console.error('unhandled rejection (suppressed):', e?.message || e));
