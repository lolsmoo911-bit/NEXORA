/**
 * NEXORA bridge — Level 4 probe: real OpenCode server compatibility.
 *
 * READ-ONLY by design. It only calls GET endpoints documented at
 * https://docs.opencode.ai/docs/server/ so it can never mutate a real agent session.
 * It never prints the server URL or any credential.
 *
 * Usage (only on a host that can reach a real opencode server):
 *   PROBE_BASE_URL=http://127.0.0.1:4096 PROBE_PASSWORD=... node test/opencode-real-probe.mjs
 *
 * Exit codes: 0 = compatible, 1 = incompatible, 2 = not configured (skipped).
 */

const baseUrl = (process.env.PROBE_BASE_URL || '').replace(/\/+$/, '');
const password = process.env.PROBE_PASSWORD || '';

if (!baseUrl) {
  console.log('SKIP: PROBE_BASE_URL is not set. Level 4 requires a reachable opencode server.');
  process.exit(2);
}

function label() {
  try { const u = new URL(baseUrl); return `${u.protocol}//${u.host}`; } catch { return 'invalid-url'; }
}

const headers = { accept: 'application/json', 'user-agent': 'nexora-opencode-bridge-probe/0.1' };
if (password) {
  headers.authorization = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
}

async function get(pathname) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(baseUrl + pathname, { headers, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function sanitize(text) {
  return String(text).replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '***')
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, '***')
    .slice(0, 200);
}

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

console.log(`Probing the real OpenCode API at ${label()}\n`);

// 1. health
const health = await get('/global/health');
record('GET /global/health responds 2xx', health.status >= 200 && health.status < 300, `status=${health.status}`);
record('health body has the documented `healthy` field', Boolean(health.json && 'healthy' in health.json),
  health.json ? `healthy=${health.json.healthy} version=${health.json.version}` : sanitize(health.text));

if (health.status === 401) {
  console.log('\nThe server requires a password. Re-run with PROBE_PASSWORD set (do not paste it into chat).');
  process.exit(checks.some((c) => !c.ok) ? 1 : 0);
}

// 2. sessions (read-only)
const sessions = await get('/session');
record('GET /session responds 2xx', sessions.status >= 200 && sessions.status < 300, `status=${sessions.status}`);
if (Array.isArray(sessions.json)) {
  record('sessions is a JSON array (documented Session[])', true, `count=${sessions.json.length}`);
} else if (sessions.json && Array.isArray(sessions.json.data)) {
  record('sessions is a JSON array (documented Session[])', true, `count=${sessions.json.data.length} (wrapped)`);
} else {
  record('sessions is a JSON array (documented Session[])', false, sanitize(sessions.text));
}

// 3. messages of the newest session (read-only), which is what opencode_task_status relies on
const list = Array.isArray(sessions.json)
  ? sessions.json
  : (sessions.json?.data || []);
if (list.length) {
  const newest = [...list].sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')))[0];
  const msgs = await get(`/session/${encodeURIComponent(newest.id)}/message`);
  record('GET /session/:id/message responds 2xx', msgs.status >= 200 && msgs.status < 300, `status=${msgs.status}`);
  const shapeOk = Array.isArray(msgs.json) ||
    (msgs.json && Array.isArray(msgs.json.data)) ||
    (msgs.json && Array.isArray(msgs.json.messages));
  record('messages match a documented list shape', Boolean(shapeOk), sanitize(msgs.text));
} else {
  console.log('SKIP: no sessions available, cannot probe the message endpoint read-only.');
}

const failed = checks.filter((c) => !c.ok);
console.log(`\nLevel 4 result: ${failed.length === 0 ? 'COMPATIBLE' : 'INCOMPATIBLE'} (${checks.length - failed.length}/${checks.length} checks passed)`);
process.exit(failed.length === 0 ? 0 : 1);
