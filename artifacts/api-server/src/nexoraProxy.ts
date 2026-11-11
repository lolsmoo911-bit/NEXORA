/**
 * NEXORA testnet — public READ-ONLY proxy.
 *
 * Additive middleware. It matches only `/api/nexora/*`, and is mounted before the
 * app's own `/api` router, so every pre-existing route behaves exactly as before.
 *
 * READ-ONLY ENFORCEMENT
 * ---------------------
 * The proxy does not forward arbitrary RPC. It validates every EVM and CometBFT
 * request against an explicit allowlist of read-only methods. Unknown methods,
 * transaction submission, signing, admin, unsafe and mempool mutation methods are
 * rejected before any bytes reach the node.
 *
 * JSON-RPC batches are validated entry by entry: one disallowed method rejects
 * the whole batch.
 *
 * Why it exists: the NEXORA validators bind loopback only. Replit's dev domain
 * publishes this server to the internet, so proxying here is what gives the chain
 * a public endpoint without a paid plan.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface RpcTarget {
  host: string;
  port: number;
}

const COMET: RpcTarget = { host: "127.0.0.1", port: 26657 };
const EVM: RpcTarget = { host: "127.0.0.1", port: 8545 };

const PREFIX = "/api/nexora";
const MAX_BODY_BYTES = 1_048_576;

/**
 * EVM JSON-RPC methods that only read chain state or simulate execution.
 * Everything else is rejected by default.
 */
const EVM_READ_METHODS: ReadonlySet<string> = new Set([
  "web3_clientVersion",
  "web3_sha3",
  "net_version",
  "net_listening",
  "net_peerCount",
  "eth_chainId",
  "eth_protocolVersion",
  "eth_blockNumber",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_syncing",
  "eth_hashrate",
  "eth_mining",
  "eth_getBalance",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getUncleCountByBlockHash",
  "eth_getUncleCountByBlockNumber",
  "eth_getCode",
  "eth_call",
  "eth_estimateGas",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockReceipts",
  "eth_getTransactionByHash",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionReceipt",
  "eth_getUncleByBlockHashAndIndex",
  "eth_getUncleByBlockNumberAndIndex",
  "eth_getLogs",
  "eth_getProof",
]);

/**
 * CometBFT JSON-RPC methods that only read consensus/application state.
 * Broadcast, unsafe, dial, subscription and mempool mutation methods are absent
 * on purpose.
 */
const COMET_READ_METHODS: ReadonlySet<string> = new Set([
  "status",
  "health",
  "net_info",
  "blockchain",
  "block",
  "block_by_hash",
  "block_results",
  "commit",
  "validators",
  "genesis",
  "genesis_chunked",
  "tx",
  "tx_search",
  "consensus_state",
  "consensus_params",
  "abci_info",
  "abci_query",
  "version",
  "node_info",
]);

/** CometBFT REST-like read endpoints (GET only). */
const COMET_READ_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/status",
  "/health",
  "/net_info",
  "/blockchain",
  "/block",
  "/block_by_hash",
  "/block_results",
  "/commit",
  "/validators",
  "/genesis",
  "/genesis_chunked",
  "/tx",
  "/tx_search",
  "/consensus_state",
  "/consensus_params",
  "/abci_info",
  "/abci_query",
  "/version",
  "/node_info",
]);

type BodyRead =
  | { ok: true; body: Buffer }
  | { ok: false; status: number; error: string };

type Validation =
  | { ok: true }
  | { ok: false; status: number; error: string; detail?: string };

function reject(
  res: Response,
  status: number,
  error: string,
  detail?: string,
): void {
  res.status(status).json(detail ? { error, detail } : { error });
}

function readBody(req: Request): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        resolve({ ok: false, status: 413, error: "payload_too_large" });
        return;
      }
      resolve({ ok: true, body: Buffer.concat(chunks) });
    });
    req.on("error", () => {
      resolve({ ok: false, status: 400, error: "bad_request" });
    });
  });
}

/**
 * Validate a JSON-RPC object or batch. Every entry must be an object with a
 * string method from the allowlist. A single disallowed entry rejects the whole
 * request so a write cannot be smuggled in beside a read.
 */
function validateJsonRpc(
  body: Buffer,
  allowed: ReadonlySet<string>,
): Validation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "invalid_jsonrpc",
      detail: "empty batch",
    };
  }

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return {
        ok: false,
        status: 400,
        error: "invalid_jsonrpc",
        detail: "each request must be an object",
      };
    }
    const method = (entry as { method?: unknown }).method;
    if (
      typeof method !== "string" ||
      method.length === 0 ||
      method.length > 128
    ) {
      return {
        ok: false,
        status: 400,
        error: "invalid_jsonrpc",
        detail: "method must be a non-empty string",
      };
    }
    if (!allowed.has(method)) {
      return { ok: false, status: 403, error: "method_not_allowed" };
    }
  }

  return { ok: true };
}

/**
 * Split a path from its query string and reject traversal-shaped input. The
 * allowlist is checked against the pathname only.
 */
function splitPath(
  rest: string,
): { pathname: string; search: string } | null {
  const queryIndex = rest.indexOf("?");
  const rawPath = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const search = queryIndex === -1 ? "" : rest.slice(queryIndex);

  if (!rawPath.startsWith("/")) return null;
  if (rawPath.includes("..") || rawPath.includes("\\") || rawPath.includes("\0")) {
    return null;
  }
  if (/%2e|%2f|%5c/i.test(rawPath)) return null;

  const pathname = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : "/";
  return { pathname: pathname || "/", search };
}

function forward(
  target: RpcTarget,
  req: Request,
  res: Response,
  pathWithQuery: string,
  method: string,
  body: Buffer,
): void {
  // Forward the client's request headers, minus hop-by-hop and credential
  // headers. A browser cookie or Authorization header must never reach the node.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (
      [
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "keep-alive",
        "authorization",
        "proxy-authorization",
        "cookie",
        "expect",
      ].includes(k)
    ) {
      continue;
    }
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  if (body.length > 0) {
    headers["content-type"] = req.headers["content-type"] ?? "application/json";
  }
  headers["content-length"] = String(body.length);

  const upstream = http.request(
    {
      host: target.host,
      port: target.port,
      path: pathWithQuery,
      method,
      headers,
      timeout: 30000,
    },
    (r) => {
      res.status(r.statusCode ?? 502);
      // Copy the upstream headers THROUGH, not just content-type, so gzip
      // responses keep their content-encoding and clients can decode them.
      for (const [k, v] of Object.entries(r.headers)) {
        if (v === undefined) continue;
        if (["connection", "transfer-encoding", "keep-alive"].includes(k)) {
          continue;
        }
        res.setHeader(k, v as string);
      }
      r.pipe(res);
    },
  );

  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.status(502).json({
        error: "nexora_upstream_unreachable",
        detail: "upstream request failed",
        hint: "are the four validators running?",
      });
    }
  });
  if (body.length) upstream.write(body);
  upstream.end();
}

export interface NexoraProxyOptions {
  comet?: RpcTarget;
  evm?: RpcTarget;
}

/**
 * Build the middleware with injectable targets so tests can point it at fake
 * loopback RPC servers without touching the real node.
 */
export function createNexoraProxy(
  options: NexoraProxyOptions = {},
): RequestHandler {
  const comet = options.comet ?? COMET;
  const evm = options.evm ?? EVM;

  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const url = req.url ?? "";
    if (!url.startsWith(PREFIX)) {
      next();
      return;
    }
    const rest = url.slice(PREFIX.length) || "/";

    if (req.method === "GET" && (rest === "/info" || rest === "/info/")) {
      let genesisSha256: string | null = null;
      try {
        const p =
          process.env["NEXORA_GENESIS_FILE"] ??
          "/home/runner/workspace/nexora-chain/testnet/genesis.json";
        genesisSha256 = createHash("sha256")
          .update(readFileSync(p))
          .digest("hex");
      } catch {
        genesisSha256 = null;
      }

      const host = req.headers.host ?? "";
      res.json({
        chain: {
          cosmosChainId: "eip155:902024",
          evmChainId: 902024,
          evmChainIdHex: "0xdc388",
          denom: "anex",
          decimals: 18,
        },
        genesisSha256,
        publicUrls: {
          note:
            "The public origin below is the ONLY externally reachable address. Node " +
            "listen_addr / rpc_address show loopback by design.",
          origin: host ? `https://${host}` : null,
          cosmosRpc: host ? `https://${host}${PREFIX}/cosmos` : null,
          evmJsonRpc: host ? `https://${host}${PREFIX}/evm` : null,
          chainInfo: host ? `https://${host}${PREFIX}/info` : null,
          method: "POST for the EVM JSON-RPC; a GET returns 405 by design",
        },
        wallet: {
          networkName: "NEXORA Testnet",
          chainId: 902024,
          chainIdHex: "0xdc388",
          currencySymbol: "ANEX",
          decimals: 18,
          rpcUrl: host ? `https://${host}${PREFIX}/evm` : null,
        },
        capabilities: {
          cosmosSide: "read-only CometBFT endpoints (explicit allowlist)",
          evmSide:
            "read-only EVM JSON-RPC (explicit allowlist; transaction submission is blocked)",
          writeMethods: "blocked by default",
          websocket: false,
          restApi: false,
          blockExplorer: false,
          p2pExternallyReachable: false,
          alwaysOn: false,
        },
        limitations: [
          "Single host: four validators, one machine.",
          "A free Replit sleeps when idle; the endpoint disappears while asleep.",
          "P2P binds loopback only, so there are no usable persistent_peers addresses.",
          "Validators and wallets use upstream PUBLIC test mnemonics and hold no value.",
        ],
      });
      return;
    }

    if (rest === "/cosmos" || rest.startsWith("/cosmos/")) {
      const sub = rest === "/cosmos" ? "/" : rest.slice("/cosmos".length);
      const split = splitPath(sub);
      if (!split) {
        reject(res, 400, "bad_request", "invalid path");
        return;
      }

      if (req.method === "GET") {
        if (!COMET_READ_PATHS.has(split.pathname)) {
          reject(res, 403, "method_not_allowed");
          return;
        }
        forward(
          comet,
          req,
          res,
          split.pathname + split.search,
          "GET",
          Buffer.alloc(0),
        );
        return;
      }

      if (req.method === "POST") {
        if (split.pathname !== "/") {
          reject(res, 405, "method_not_allowed");
          return;
        }
        const read = await readBody(req);
        if (!read.ok) {
          reject(res, read.status, read.error);
          return;
        }
        const valid = validateJsonRpc(read.body, COMET_READ_METHODS);
        if (!valid.ok) {
          reject(res, valid.status, valid.error, valid.detail);
          return;
        }
        forward(comet, req, res, "/", "POST", read.body);
        return;
      }

      reject(res, 405, "method_not_allowed");
      return;
    }

    if (rest === "/evm" || rest === "/evm/") {
      if (req.method !== "POST") {
        reject(res, 405, "method_not_allowed");
        return;
      }
      const read = await readBody(req);
      if (!read.ok) {
        reject(res, read.status, read.error);
        return;
      }
      const valid = validateJsonRpc(read.body, EVM_READ_METHODS);
      if (!valid.ok) {
        reject(res, valid.status, valid.error, valid.detail);
        return;
      }
      forward(evm, req, res, "/", "POST", read.body);
      return;
    }

    next();
  };
}

export const nexoraProxy = createNexoraProxy();
