/**
 * NEXORA testnet faucet — POST /api/nexora/faucet
 *
 * Valueless test funds only. Safety properties, each enforced here rather than
 * documented and hoped for:
 *
 *   - Refuses to run unless the chain id is the testnet id. A misconfigured
 *     MAINNET deployment makes this module throw at import time rather than
 *     fund a real chain.
 *   - POST only. A GET is a wallet prefetch or a link preview, and neither
 *     should move money.
 *   - Never returns, logs, or accepts a private key. The signing key is read
 *     from the local keyring by name; it is never transmitted, never echoed,
 *     and never accepted as input.
 *   - Client identity comes from the TCP peer by default. X-Forwarded-For is
 *     ignored unless the peer itself is an explicitly configured trusted proxy.
 *   - Budgets and cooldowns are enforced in the durable PostgreSQL ledger, not
 *     in process memory. A reservation is written before evmd is executed.
 *   - Capped per request, per recipient per UTC day, and globally per UTC day.
 *   - If the ledger cannot be read or updated safely, no tokens are sent.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { Request, Response } from "express";
import { logger } from "./lib/logger.ts";
import type {
  FaucetReserveResult,
  FaucetStore,
} from "./nexoraFaucetStore.ts";

const run = promisify(execFile);

/** True for loopback literals only. */
function isLoopbackUrl(value: string) {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

export const TESTNET_CHAIN_ID = "eip155:902024";
export const DEFAULT_COOLDOWN_MS = 60_000; // one request per client per minute
export const DEFAULT_MAX_PER_REQUEST = 10n ** 21n; // 1000 ANEX
export const DEFAULT_PAYOUT = 10n ** 20n; // 100 ANEX
export const DEFAULT_RECIPIENT_DAILY_CAP = 5n * 10n ** 21n; // 5000 ANEX
export const DEFAULT_DAILY_CAP = 50n * 10n ** 21n; // 50000 ANEX

type IpFamily = 4 | 6;

interface NormalisedIp {
  address: string;
  family: IpFamily;
}

function normaliseIp(value: string): NormalisedIp | null {
  let candidate = value.trim();
  if (!candidate) return null;
  if (candidate.startsWith("::ffff:")) {
    const mapped = candidate.slice("::ffff:".length);
    if (isIP(mapped) === 4) candidate = mapped;
  }
  const family = isIP(candidate);
  if (family === 4) return { address: candidate, family: 4 };
  if (family === 6) return { address: candidate.toLowerCase(), family: 6 };
  return null;
}

function isTrusted(list: BlockList, ip: NormalisedIp): boolean {
  return list.check(ip.address, ip.family === 4 ? "ipv4" : "ipv6");
}

export interface TrustedProxyList {
  list: BlockList | null;
  error?: string;
}

/**
 * Parse explicit trusted-proxy IPs or CIDRs. A /0 range is rejected: trusting
 * every peer would make X-Forwarded-For spoofable again.
 */
export function buildTrustedProxyList(entries: string[]): TrustedProxyList {
  const cleaned = entries.map((entry) => entry.trim()).filter(Boolean);
  if (cleaned.length === 0) return { list: null };

  const list = new BlockList();
  for (const entry of cleaned) {
    const slash = entry.indexOf("/");
    const addressPart = slash === -1 ? entry : entry.slice(0, slash);
    const prefixPart = slash === -1 ? null : entry.slice(slash + 1);
    const ip = normaliseIp(addressPart);
    if (!ip) {
      return { list: null, error: `invalid trusted proxy address: ${entry}` };
    }
    const type = ip.family === 4 ? "ipv4" : "ipv6";
    if (prefixPart === null) {
      list.addAddress(ip.address, type);
      continue;
    }
    if (!/^\d+$/.test(prefixPart)) {
      return { list: null, error: `invalid trusted proxy prefix: ${entry}` };
    }
    const prefix = Number(prefixPart);
    const maximum = ip.family === 4 ? 32 : 128;
    if (prefix < 1 || prefix > maximum) {
      return {
        list: null,
        error: `trusted proxy prefix must be between 1 and ${maximum}: ${entry}`,
      };
    }
    list.addSubnet(ip.address, prefix, type);
  }
  return { list };
}

export function parseTrustedProxyEntries(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Resolve the client identity.
 *
 * Default: the actual TCP peer. X-Forwarded-For is ignored completely.
 * Trusted proxy: only when the peer matches the explicit trusted list. Walk the
 * X-Forwarded-For chain from right to left, skipping trusted proxies, and take
 * the first untrusted address. Forged entries on the left cannot win because
 * the rightmost address is the one appended by the trusted peer.
 */
export function resolveClientAddress(
  req: Request,
  trusted: BlockList | null,
): string | null {
  const peer = normaliseIp(req.socket?.remoteAddress ?? "");
  if (!peer) return null;
  if (!trusted || !isTrusted(trusted, peer)) return peer.address;

  const rawHeader = req.headers["x-forwarded-for"];
  const raw = Array.isArray(rawHeader) ? rawHeader.join(",") : rawHeader;
  if (!raw) return peer.address;

  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return peer.address;

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const candidate = normaliseIp(parts[index] ?? "");
    if (!candidate) return peer.address;
    if (!isTrusted(trusted, candidate)) return candidate.address;
  }
  return peer.address;
}

/** Hash the resolved address before it reaches the ledger or any log. */
export function clientKeyFor(address: string): string {
  return createHash("sha256")
    .update(`nexora-faucet:${address}`)
    .digest("hex");
}

export interface FaucetConfig {
  opencode: { baseUrl?: string };
  faucetHome?: string;
  faucetAccount: string;
  faucetNode: string;
  faucetChainId?: string;
  faucetGasPrice?: string;
  evmdPath: string;
  store: FaucetStore;
  trustedProxies?: BlockList | null;
  cooldownMs?: number;
  maxPerRequest?: bigint;
  defaultPayout?: bigint;
  recipientDailyCap?: bigint;
  dailyCap?: bigint;
  configError?: string;
  runner?: (
    cmd: string,
    args: string[],
    opts: { timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

function isAddress(s: unknown) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

/** Reject anything that is not obviously a plain EVM address. */
function normaliseAddress(raw: unknown) {
  const s = String(raw ?? "").trim();
  if (!isAddress(s)) return null;
  const body = s.slice(2).toLowerCase();
  if (/^0+$/.test(body)) return null; // the zero address burns funds permanently
  return "0x" + body;
}

/** Remove credentials, keys, and long tokens from evmd stderr/messages. */
export function redactFaucetErrorDetail(detail: string): string {
  let redacted = detail;
  redacted = redacted.replace(
    /\b(authorization|proxy-authorization|cookie)\b\s*[:=]\s*[^\r\n]+/gi,
    (_match, key: string) => `${key}=[redacted]`,
  );
  redacted = redacted.replace(
    /\bmnemonic\b\s*[:=]\s*[^\r\n]+/gi,
    "mnemonic=[redacted]",
  );
  redacted = redacted.replace(
    /\b(password|passwd|secret|token|private[_-]?key)\b\s*[:=]\s*[^\s,;]+/gi,
    (_match, key: string) => `${key}=[redacted]`,
  );
  redacted = redacted.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
  redacted = redacted.replace(/\bBasic\s+\S+/gi, "Basic [redacted]");
  redacted = redacted.replace(/\b0x[0-9a-fA-F]{40,}\b/g, "[redacted]");
  redacted = redacted.replace(/\b[0-9a-fA-F]{64,}\b/g, "[redacted]");
  redacted = redacted.replace(/\b[A-Za-z0-9+/=_-]{80,}\b/g, "[redacted]");
  return redacted.slice(0, 300);
}

function ledgerFailure(stage: string, error: unknown): void {
  const rawCode = (error as { code?: unknown } | null)?.code;
  const code =
    typeof rawCode === "string" && /^[A-Z0-9_]{1,32}$/.test(rawCode)
      ? rawCode
      : "unknown";
  logger.error(
    { event: "faucet_ledger_failure", stage, code },
    "Faucet ledger operation failed",
  );
}

function runnerFailureDetail(error: unknown): string {
  let detail = "";
  if (error instanceof Error) {
    const execErr = error as Error & { stderr?: unknown };
    detail =
      typeof execErr.stderr === "string" ? execErr.stderr : execErr.message;
  } else {
    detail = String(error ?? "");
  }
  return redactFaucetErrorDetail(detail);
}

export async function handleFaucet(
  req: Request,
  res: Response,
  cfg: FaucetConfig,
): Promise<void> {
  // ---- configuration must be safe before anything else ----------------------
  if (cfg.configError) {
    res.status(503).json({
      error: "faucet_misconfigured",
      detail: cfg.configError,
    });
    return;
  }

  const cooldownMs = cfg.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const maxPerRequest = cfg.maxPerRequest ?? DEFAULT_MAX_PER_REQUEST;
  const defaultPayout = cfg.defaultPayout ?? DEFAULT_PAYOUT;
  const recipientDailyCap =
    cfg.recipientDailyCap ?? DEFAULT_RECIPIENT_DAILY_CAP;
  const dailyCap = cfg.dailyCap ?? DEFAULT_DAILY_CAP;

  if (
    !Number.isFinite(cooldownMs) ||
    cooldownMs < 0 ||
    maxPerRequest <= 0n ||
    defaultPayout <= 0n ||
    recipientDailyCap <= 0n ||
    dailyCap <= 0n
  ) {
    res.status(503).json({ error: "faucet_misconfigured" });
    return;
  }

  // ---- safety rail 1: this must never run on anything but the testnet ------
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

  // ---- safety rail 2: POST only --------------------------------------------
  if (req.method !== "POST") {
    res.status(405).json({
      error: "post_only",
      detail: "Use POST with a JSON body. A GET must never move funds.",
    });
    return;
  }

  // ---- safety rail 3: identify the actual client ---------------------------
  const clientAddress = resolveClientAddress(req, cfg.trustedProxies ?? null);
  if (!clientAddress) {
    res.status(503).json({
      error: "faucet_client_unavailable",
      detail: "The server could not determine the client address.",
    });
    return;
  }
  const clientKey = clientKeyFor(clientAddress);

  // ---- safety rail 4: input validation -------------------------------------
  const to = normaliseAddress(req.body?.address);
  if (!to) {
    res.status(400).json({
      error: "bad_address",
      detail: "Provide a 0x-prefixed 40-hex EVM address, not the zero address.",
    });
    return;
  }

  let requested: bigint;
  try {
    requested = BigInt(req.body?.amount ?? defaultPayout);
  } catch {
    res.status(400).json({ error: "bad_amount" });
    return;
  }
  if (!Number.isFinite(Number(requested)) || requested <= 0n) {
    res.status(400).json({ error: "bad_amount" });
    return;
  }
  const payout = requested > maxPerRequest ? maxPerRequest : requested;

  const home = cfg.faucetHome;
  if (!home) {
    res.status(503).json({ error: "faucet_not_configured" });
    return;
  }

  // ---- safety rail 5: durable budget reservation ---------------------------
  if (!cfg.store) {
    res.status(503).json({
      error: "faucet_ledger_unavailable",
      detail: "The faucet ledger is unavailable; no funds were sent.",
    });
    return;
  }

  let reservation: FaucetReserveResult;
  try {
    reservation = await cfg.store.reserve({
      clientKey,
      recipient: to,
      amount: payout,
      maxPerRequest,
      cooldownMs,
      recipientDailyCap,
      dailyCap,
    });
  } catch (error) {
    ledgerFailure("reserve", error);
    res.status(503).json({
      error: "faucet_ledger_unavailable",
      detail: "The faucet ledger is unavailable; no funds were sent.",
    });
    return;
  }

  if (!reservation.ok) {
    switch (reservation.reason) {
      case "client_cooldown":
        res.status(429).json({
          error: "rate_limited",
          retryAfterSeconds: reservation.retryAfterSeconds,
        });
        return;
      case "recipient_daily_limit":
        res.status(429).json({
          error: "recipient_daily_limit",
          retryAfterSeconds: reservation.retryAfterSeconds,
        });
        return;
      case "daily_limit":
        res.status(429).json({
          error: "faucet_daily_limit",
          retryAfterSeconds: reservation.retryAfterSeconds,
        });
        return;
      case "invalid_amount":
        res.status(400).json({ error: "bad_amount" });
        return;
      case "store_unavailable":
      default:
        res.status(503).json({
          error: "faucet_ledger_unavailable",
          detail: "The faucet ledger is unavailable; no funds were sent.",
        });
        return;
    }
  }

  // ---- send. The signing key never leaves the local keyring. ---------------
  const evmd = cfg.evmdPath;
  const amount = `${payout}anex`;
  const runner = cfg.runner ?? run;

  let stdout: string;
  try {
    const result = await runner(
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
    stdout = result.stdout;
  } catch (error) {
    try {
      await cfg.store.finalize(reservation.id, { status: "failed" });
    } catch (finalizeError) {
      ledgerFailure("finalize_failed", finalizeError);
    }
    res.status(502).json({
      error: "faucet_send_failed",
      detail: runnerFailureDetail(error),
    });
    return;
  }

  let parsed: { txhash?: unknown };
  try {
    parsed = JSON.parse(stdout) as { txhash?: unknown };
  } catch {
    try {
      await cfg.store.finalize(reservation.id, { status: "failed" });
    } catch (finalizeError) {
      ledgerFailure("finalize_failed", finalizeError);
    }
    res.status(502).json({
      error: "faucet_send_failed",
      detail: "evmd returned an unreadable response.",
    });
    return;
  }

  const txHash =
    typeof parsed.txhash === "string" ? parsed.txhash : undefined;
  try {
    await cfg.store.finalize(reservation.id, { status: "sent", txHash });
  } catch (finalizeError) {
    // The transfer may already be on chain. The reservation remains counted
    // against every budget, so a ledger write failure cannot release funds.
    ledgerFailure("finalize_sent", finalizeError);
  }

  res.json({
    ok: true,
    txhash: parsed.txhash,
    to,
    amountAnex: Number(payout) / 1e18,
    note: "Valueless testnet funds. Receipts are not indexed by this chain — verify by balance.",
  });
}
