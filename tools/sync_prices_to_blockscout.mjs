import fs from 'fs';

const PRICES = '/home/runner/workspace/nexora-plan/token_prices.json';
const PSQL = ['psql', '-h', '127.0.0.1', '-p', '5433', '-U', 'blockscout', '-d', 'blockscout', '-v', 'ON_ERROR_STOP=1', '-t', '-A'];
const env = { ...process.env, PGPASSWORD: 'blockscout' };
const dryRun = process.argv.includes('--dry-run');

import { execFileSync } from 'child_process';
const q = (sql) => execFileSync(PSQL[0], PSQL.slice(1).concat(['-c', sql]), { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
// one psql process for the WHOLE batch (stdin script, single transaction) — spawning a
// process per token was ~100ms x N tokens and dominated the 5-minute cycle
function qScript(script) {
  return execFileSync(PSQL[0], PSQL.slice(1).concat(['-f', '-']), { env, encoding: 'utf8', input: script, maxBuffer: 64 * 1024 * 1024 }).trim();
}

const t0 = Date.now();
const data = JSON.parse(fs.readFileSync(PRICES, 'utf8'));
const entries = Object.values(data.prices);

// build maps from DB (single read query)
const dbRows = q("select encode(contract_address_hash,'hex'), symbol, coalesce(name,'') from tokens;").split('\n').filter(Boolean).map(l => {
  const [addr, sym, name] = l.split('|'); return { addr: (addr || '').toLowerCase(), sym, name };
});
const byAddr = new Map(dbRows.map(r => [r.addr, r]));
const bySymName = new Map(dbRows.map(r => [`${r.sym}||${r.name}`, r.addr]));
const symCount = new Map();
for (const r of dbRows) symCount.set(r.sym, (symCount.get(r.sym) || 0) + 1);
// symbol-only fallback ONLY when the symbol is unique in the DB — otherwise a duplicate
// symbol (two categories sharing a ticker) would silently misprice a token
const bySym = new Map();
for (const r of dbRows) if (symCount.get(r.sym) === 1 && !bySym.has(r.sym)) bySym.set(r.sym, r.addr);

const HEX = /^[0-9a-f]{40}$/;
let resolved = 0, applied = 0, skipNoAddr = 0, skipNoPrice = 0, fail = 0;

// resolve + validate every entry BEFORE touching the DB
const updates = [];
for (const p of entries) {
  const price = Number(p.price_usd);
  if (p.price_usd == null || !isFinite(price) || price <= 0) { skipNoPrice++; continue; }
  let addr = (p.token_address || '').replace(/^0x/, '').toLowerCase();
  if (!HEX.test(addr)) addr = bySymName.get(`${p.symbol}||${p.name}`) || bySym.get(p.symbol) || null;
  if (!addr || !HEX.test(addr)) { skipNoAddr++; continue; }
  updates.push({ addr, price });
}

const sqlPrice = (n) => Number(n.toFixed(8)).toString(); // finite numeric literal, no scientific notation
const CHUNK = 900; // rows per statement — comfortably under parameter/parse limits

if (!dryRun) {
  let stmts = [];
  stmts.push('BEGIN;');
  for (let i = 0; i < updates.length; i += CHUNK) {
    const rows = updates.slice(i, i + CHUNK)
      .map(u => `(decode('${u.addr}','hex'), ${sqlPrice(u.price)}::numeric)`)
      .join(',');
    stmts.push(`UPDATE tokens SET fiat_value=v.price, updated_at=NOW() FROM (VALUES ${rows}) AS v(addr,price) WHERE tokens.contract_address_hash=v.addr;`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const csto = data.prices['Native|CSTO']?.price_usd ?? 3;
  const marketCap = 100000000000 * Number(csto);
  stmts.push(`INSERT INTO market_history (date, closing_price, opening_price, market_cap, secondary_coin) VALUES ('${today}', ${sqlPrice(csto)}, ${sqlPrice(csto)}, ${sqlPrice(marketCap)}, false) ON CONFLICT (date, secondary_coin) DO UPDATE SET closing_price=EXCLUDED.closing_price, opening_price=EXCLUDED.opening_price, market_cap=EXCLUDED.market_cap;`);
  stmts.push('COMMIT;');
  try {
    const out = qScript(stmts.join('\n'));
    // psql echoes one "UPDATE n" line per statement — sum the actually-applied rows
    resolved = (out.match(/UPDATE\s+(\d+)/g) || []).reduce((s, m) => s + Number(m.replace(/\D+/g, '')), 0);
    applied = resolved;
  } catch (e) {
    fail = updates.length;
    console.error('batch update failed:', String(e.stderr || e.message).slice(0, 500));
  }
} else {
  resolved = updates.length; // dry-run: what WOULD be pushed
  applied = 0;
}

console.log(JSON.stringify({
  updated_tokens: applied,
  resolved, fail,
  skip: { no_price: skipNoPrice, no_address: skipNoAddr },
  dry_run: dryRun,
  csto_usd: data.prices['Native|CSTO']?.price_usd ?? 3,
  market_cap: 100000000000 * (data.prices['Native|CSTO']?.price_usd ?? 3),
  durationMs: Date.now() - t0,
  ts: new Date().toISOString(),
}));
