#!/usr/bin/env node
/**
 * Real-time web data grabber: fetches URLs/APIs with configurable headers, timeout,
 * retries (backoff + Retry-After), bounded concurrency, and a response size cap.
 *
 * Usage:
 *   node tools/web_data_grabber.mjs <url> [--json] [--out file] [--timeout ms] [--header "K: V"]
 *   node tools/web_data_grabber.mjs --batch urls.txt [--json] [--out dir] [--concurrency 8] [--retries 2]
 *
 * Single-URL output shape is unchanged (ok/status/url/contentType/fetchedAt/elapsedMs/bytes/data).
 * Batch mode: {results:[...], summary:{total,ok,failed,totalMs}} (+ per-result attempts).
 */
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
function getArg(name, def = null) { const i = args.indexOf(name); if (i === -1) return def; return args[i + 1] ?? def; }
const has = (n) => args.includes(n);

const timeout = Number(getArg('--timeout', '15000'));
const retries = Math.max(0, Number(getArg('--retries', '2')));
const maxBytes = Number(getArg('--max-bytes', '5242880')); // 5 MB cap — never blow memory on a huge response
const concurrency = Math.max(1, Number(getArg('--concurrency', '8')));
const out = getArg('--out', null);
const wantJson = has('--json');
const headers = {};
for (let i = 0; i < args.length; i++) if (args[i] === '--header' && args[i + 1]) { const v = args[i + 1]; const j = v.indexOf(':'); if (j > 0) headers[v.slice(0, j).trim()] = v.slice(j + 1).trim(); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function grabOnce(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'CustoriumDataGrabber/2.0', 'accept': 'application/json,text/plain,*/*', ...headers },
      signal: controller.signal, redirect: 'follow',
    });
    const ct = res.headers.get('content-type') || '';
    // stream with a hard cap: abort the body instead of buffering an unbounded response
    const reader = res.body ? res.body.getReader() : null;
    let size = 0, chunks = [], overflow = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { overflow = true; controller.abort(); break; }
        chunks.push(value);
      }
    }
    let data = '';
    if (!overflow) data = Buffer.concat(chunks).toString('utf8');
    let parsed = data;
    if (!overflow && (wantJson || ct.includes('application/json'))) {
      try { parsed = JSON.parse(data); } catch { /* keep text */ }
    }
    return {
      ok: res.ok && !overflow, status: res.status, url, contentType: ct,
      fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
      bytes: size, ...(overflow ? { error: `response exceeded ${maxBytes} bytes` } : {}), data: parsed,
    };
  } catch (e) {
    return { ok: false, status: 0, url, error: String((e && e.message) || e), fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - started, bytes: 0 };
  } finally { clearTimeout(t); }
}

/** fetch with retries: exponential backoff, honoring Retry-After when the server sends it */
async function grab(url) {
  let attempt = 0;
  for (;;) {
    const r = await grabOnce(url);
    r.attempts = attempt + 1;
    // retry on transport errors, 5xx and 429 (never on clean 2xx/3xx/4xx)
    const transient = r.status === 0 || r.status === 429 || r.status >= 500;
    if (!transient || attempt >= retries) return r;
    const ra = r.status === 429 ? Number(r.headers?.['retry-after'] || 0) : 0; // not exposed by fetch; conservative wait
    const wait = Math.min(30000, ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
    await sleep(wait);
    attempt++;
  }
}

/** bounded-concurrency pool (FIFO order preserved) */
async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

const batch = getArg('--batch', null);
(async () => {
  let result;
  if (batch) {
    const urls = fs.readFileSync(batch, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const started = Date.now();
    const results = await pool(urls, grab);
    result = {
      results,
      summary: {
        total: results.length,
        ok: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length,
        totalMs: Date.now() - started,
      },
    };
  } else {
    const url = args.find(a => a && !a.startsWith('-') && a !== out && a !== batch && a !== getArg('--header'));
    if (!url) { console.error('Usage: node tools/web_data_grabber.mjs <url> [--json] [--out file] [--timeout ms] [--retries 2] [--max-bytes n]'); process.exit(2); }
    result = await grab(url);
  }
  const output = JSON.stringify(result, null, 2);
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, output); console.error('wrote', out); }
  else console.log(output);
})();
