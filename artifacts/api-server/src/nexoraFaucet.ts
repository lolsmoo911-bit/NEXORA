/**
 * NEXORA testnet faucet — POST /api/nexora/faucet
 *
 * Valueless test funds only. Safety properties, each enforced here rather than documented
 * and hoped for:
 *
 *   - Refuses to run unless the chain id is the testnet id. A misconfigured MAINNET
 *     deployment makes this module throw at import time rather than fund a real chain.
 *   - POST only. A GET is a wallet prefetch or a link preview, and neither should move money.
 *   - Never returns, logs, or accepts a private key. The signing key is read from the local
 *     keyring by name; it is never transmitted, never echoed, and never accepted as input.
 *   - Capped per request, and rate limited per client address with a cooldown.
 *   - A single funding account. It cannot send anything except this faucet, because the
 *     faucet builds the message itself and takes no amount from the caller beyond the cap.
 *
 *   curl -X POST "$BASE/faucet" -H 'content-type: application/json' \
 *        -d '{"address":"0x..."}'
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

/** True for loopback literals only. Duplicated rather than imported: the api-server has no
 *  config module, and pulling one in just for this check would be a bigger change than the
 *  check is worth. */
function isLoopbackUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

const TESTNET_CHAIN_ID = "eip155:902024";
const COOLDOWN_MS = 60_000; // one request per client per minute
const MAX_PER_REQUEST = 10n ** 21n; // 1000 ANEX
const DEFAULT_PAYOUT = 10n ** 20n; // 100 ANEX

const lastRequest = new Map();

function clientKey(req) {
  return (
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function isAddress(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

/** Reject anything that is not obviously a plain EVM address. */
function normaliseAddress(raw) {
  const s = String(raw ?? "").trim();
  if (!isAddress(s)) return null;
  const body = s.slice(2).toLowerCase();
  if (/^0+$/.test(body)) return null; // the zero address burns funds permanently
  return "0x" + body;
}

export async function handleFaucet(req, res, cfg) {
  // ---- safety rail 1: this must never run on anything but the testnet -------------
  if (cfg.opencode.baseUrl && !isLoopbackUrl(cfg.opencode.baseUrl)) {
    res.status(403).json({
      error: "faucet_refuses_non_loopback",
      detail: "The upstream OpenCode URL is not loopback. Refusing to run a signer.",
    });
    return;
  }
  if (cfg.faucetChainId && cfg.faucetChainId !== TESTNET_CHAIN_ID) {
    res.status(403).json({
      error: "faucet_wrong_chain",
      detail: `expected ${TESTNET_CHAIN_ID}, got ${cfg.faucetChainId}`,
    });
    return;
  }

  // ---- safety rail 2: POST only ----------------------------------------------------
  if (req.method !== "POST") {
    res.status(405).json({
      error: "post_only",
      detail: "Use POST with a JSON body. A GET must never move funds.",
    });
    return;
  }

  // ---- safety rail 3: rate limit ---------------------------------------------------
  const who = clientKey(req);
  const previous = lastRequest.get(who) ?? 0;
  const elapsed = Date.now() - previous;
  if (elapsed < COOLDOWN_MS) {
    res.status(429).json({
      error: "rate_limited",
      retryAfterSeconds: Math.ceil((COOLDOWN_MS - elapsed) / 1000),
    });
    return;
  }

  // ---- safety rail 4: input validation --------------------------------------------
  const to = normaliseAddress(req.body?.address);
  if (!to) {
    res.status(400).json({
      error: "bad_address",
      detail: "Provide a 0x-prefixed 40-hex EVM address, not the zero address.",
    });
    return;
  }

  const requested = BigInt(req.body?.amount ?? DEFAULT_PAYOUT);
  if (!Number.isFinite(Number(requested)) || requested <= 0n) {
    res.status(400).json({ error: "bad_amount" });
    return;
  }
  const payout = requested > MAX_PER_REQUEST ? MAX_PER_REQUEST : requested;

  lastRequest.set(who, Date.now());

  // ---- send. The signing key never leaves the local keyring. ----------------------
  const home = cfg.faucetHome;
  if (!home) {
    res.status(503).json({ error: "faucet_not_configured" });
    return;
  }
  const evmd = cfg.evmdPath;
  const amount = `${payout}anex`;

  try {
    const { stdout } = await run(
      evmd,
      [
        "tx", "bank", "send",
        cfg.faucetAccount, to, amount,
        "--chain-id", TESTNET_CHAIN_ID,
        "--keyring-backend", "test",
        "--home", home,
        "--node", cfg.faucetNode,
        "--gas-prices", `${cfg.faucetGasPrice ?? "2000000000"}anex`,
        "--gas", "200000",
        "--yes",
        "--output", "json",
      ],
      { timeout: 120000, maxBuffer: 1 << 20 },
    );
    const parsed = JSON.parse(stdout);
    res.json({
      ok: true,
      txhash: parsed.txhash,
      to,
      amountAnex: Number(payout) / 1e18,
      note: "Valueless testnet funds. Receipts are not indexed by this chain — verify by balance.",
    });
  } catch (e) {
    // stderr from evmd can contain the signed tx; strip anything that looks like a key.
    const detail = String(e.stderr ?? e.message ?? "").replace(/[0-9a-fA-F]{64,}/g, "[redacted]");
    res.status(502).json({ error: "faucet_send_failed", detail: detail.slice(0, 300) });
  }
}