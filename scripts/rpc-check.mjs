#!/usr/bin/env node
/**
 * nexora-rpc-check — diagnose why a wallet cannot use an RPC endpoint.
 *
 * Wallets (Trust Wallet, MetaMask) report every TLS, DNS, timeout and JSON-RPC failure
 * as the same message: "Could not fetch chain ID. Is your RPC URL correct?" That message
 * is almost never about the chain ID.
 *
 * This checks each layer in order and names the one that actually fails.
 *
 *   node scripts/rpc-check.mjs <rpc-url>
 *   node scripts/rpc-check.mjs <rpc-url> --expected-chain-id 902024
 *
 * Exit 0 = usable by wallets. Exit 1 = a layer failed.
 */

const url = process.argv[2];
const expectedArg = process.argv.indexOf("--expected-chain-id");
const EXPECTED = expectedArg > -1 ? process.argv[expectedArg + 1] : "902024";

if (!url) {
  console.error("usage: node scripts/rpc-check.mjs <rpc-url> [--expected-chain-id N]");
  process.exit(2);
}

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m",
};
let failures = 0;
const ok = (m) => console.log(`  ${C.green}PASS${C.reset}  ${m}`);
const bad = (m) => { failures++; console.log(`  ${C.red}FAIL${C.reset}  ${m}`); };
const warn = (m) => console.log(`  ${C.yellow}WARN${C.reset}  ${m}`);
const head = (m) => console.log(`\n${C.bold}${m}${C.reset}`);
const dim = (m) => console.log(`       ${C.dim}${m}${C.reset}`);

let u;
try {
  u = new URL(url);
} catch {
  console.error(`${C.red}not a valid URL: ${url}${C.reset}`);
  process.exit(2);
}

// ---------------------------------------------------------------- 1. scheme
head("1. URL");
if (u.protocol === "https:") ok(`scheme https://${u.host}`);
else if (u.protocol === "http:") {
  bad(`scheme is http:// — most wallets refuse plain HTTP outside localhost`);
} else {
  bad(`unsupported scheme ${u.protocol}`);
  process.exit(1);
}
if (u.search || u.hash) warn("query string or fragment present — strip it, some wallets include it in the path");

// ---------------------------------------------------------------- 2. DNS
head("2. DNS");
try {
  const { addressType, addresses } = await import("node:dns").then(
    (m) => new Promise((res, rej) => m.lookup(u.hostname, { all: true }, (e, a) => (e ? rej(e) : res({ addressType: "IPv", addresses: a })))),
  );
  ok(`${u.hostname} -> ${addresses.map((a) => a.address).join(", ")}`);
} catch (e) {
  bad(`DNS resolution failed: ${e.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- 3. TLS
head("3. TLS certificate");
if (u.protocol === "https:") {
  try {
    const tls = await import("node:tls");
    const socket = tls.connect({ host: u.hostname, port: 443, servername: u.hostname });
    const peer = await new Promise((res, rej) => {
      socket.once("secureConnect", () => res(socket.getPeerCertificate(true)));
      socket.once("error", rej);
      setTimeout(() => rej(new Error("TLS handshake timed out")), 15000);
    });
    socket.destroy();
    const issuer = peer.issuer?.CN ?? peer.issuer?.O ?? "?";
    const subject = peer.subject?.CN ?? "?";
    const expires = peer.valid_to;
    const remaining = Math.floor((new Date(expires) - Date.now()) / 86400000);
    dim(`leaf: ${subject}`);
    dim(`issuer: ${issuer}`);
    dim(`expires: ${expires} (${remaining} days)`);
    ok("TLS handshake succeeded");

    // THE failure that matters. A private interception CA validates inside the environment
    // that issued it and nowhere else. Wallets on a phone have never heard of it.
    //
    // Google Trust Services issues intermediate CAs with short common names ("WE1", "WE2")
    // and no "Google Trust Services" string, so those shorthands must be listed or a
    // perfectly valid public certificate gets reported as private.
    const publicCAs =
      /Let's Encrypt|Google Trust|GTS Root|GlobalSign|DigiCert|ISRG|ZeroSSL|Baltimore|Sectigo|Amazon Root|Microsoft RSA|Entrust|Baltimore|CF Certificate|^WE\d+$/i;
    if (!publicCAs.test(issuer)) {
      bad(`certificate is issued by a PRIVATE CA: "${issuer}"`);
      dim("This validates only on machines that already trust that CA — typically the");
      dim("machine inside the environment that generated it. A phone has never heard of");
      dim("it, so the TLS handshake fails and the wallet reports a chain-ID error.");
      dim("");
      dim("This is not fixable from the endpoint side. Either the certificate must be");
      dim("issued by a publicly trusted CA for a real hostname, or the endpoint must be");
      dim("reached over a channel that already terminates TLS publicly.");
    } else {
      ok("issuer is a publicly trusted CA");
    }
    if (remaining < 14) warn(`certificate expires in ${remaining} days`);
  } catch (e) {
    bad(`TLS failed: ${e.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 4. JSON-RPC
head("4. JSON-RPC over HTTP");
async function rpc(method, params = [], headers = {}) {
  const t0 = Date.now();
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, ms: Date.now() - t0 };
}

for (const [label, headers] of [
  ["plain", {}],
  ["Accept-Encoding: gzip", { "accept-encoding": "gzip" }],
  ["wallet user-agent", { "user-agent": "MetaMask/12.0 (Android 13)" }],
]) {
  try {
    const r = await rpc("eth_chainId", [], headers);
    const ct = r.headers.get("content-type") ?? "";
    const ce = r.headers.get("content-encoding");
    let parsed = null;
    try { parsed = JSON.parse(r.text); } catch { /* below */ }
    if (r.status === 200 && parsed?.result === "0x" + Number(EXPECTED).toString(16)) {
      ok(`${label}: HTTP 200 in ${r.ms}ms -> ${parsed.result}`);
      if (ce && ce.includes("gzip") && r.text.startsWith("{")) {
        warn(`${label}: body looks uncompressed but header says ${ce}`);
      }
    } else {
      bad(`${label}: HTTP ${r.status} ${r.ms}ms ct=${ct} body=${r.text.slice(0, 120)}`);
    }
  } catch (e) {
    bad(`${label}: ${e.message}`);
  }
}

// ---------------------------------------------------------------- 5. wallet behaviours
head("5. Wallet-specific behaviours");
try {
  const r = await fetch(url, { method: "GET", signal: AbortSignal.timeout(15000) });
  if (r.status === 405) ok("GET returns 405 (POST-only) — normal, wallets use POST");
  else if (r.status === 200) warn(`GET returns 200 — some wallets use it to probe`);
  else warn(`GET returned ${r.status}`);
} catch (e) { warn(`GET failed: ${e.message}`); }

try {
  const r = await fetch(url, {
    method: "OPTIONS",
    headers: {
      origin: "chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn",
      "access-control-request-method": "POST",
    },
    signal: AbortSignal.timeout(15000),
  });
  const acao = r.headers.get("access-control-allow-origin");
  if (r.status === 204 || r.status === 200) ok(`CORS preflight ${r.status}, allow-origin: ${acao ?? "(none)"}`);
  else bad(`CORS preflight returned ${r.status}`);
} catch (e) { warn(`CORS preflight failed: ${e.message}`); }

try {
  const r = await rpc("net_version");
  if (r.text.includes(EXPECTED)) ok(`net_version -> ${EXPECTED}`);
  else bad(`net_version mismatch: ${r.text.slice(0, 100)}`);
} catch (e) { bad(`net_version: ${e.message}`); }

try {
  const r = await rpc("eth_blockNumber");
  if (r.status === 200 && /"result":"0x[0-9a-f]+"/.test(r.text)) ok(`eth_blockNumber -> ${r.text.match(/"result":"(0x[0-9a-f]+)"/)[1]}`);
  else bad(`eth_blockNumber: ${r.text.slice(0, 100)}`);
} catch (e) { bad(`eth_blockNumber: ${e.message}`); }

// ---------------------------------------------------------------- verdict
console.log(`\n${C.bold}${C.cyan}RESULT${C.reset}`);
if (failures === 0) {
  console.log(`${C.green}All layers passed. The endpoint is reachable and speaks correct JSON-RPC.`);
  console.log(`If a wallet still refuses it, the problem is the wallet: a cached earlier`);
  console.log(`failure, a stale network entry, or its own connectivity.\n`);
} else {
  console.log(`${C.red}${failures} layer(s) failed.${C.reset} The first FAIL above is the cause.`);
  console.log(`Wallet apps report every one of these as "Could not fetch chain ID.`);
  console.log(`Is your RPC URL correct?" — that message is not about the chain ID.\n`);
}
process.exit(failures === 0 ? 0 : 1);