/**
 * NEXORA testnet — public read-only proxy.
 *
 * Additive middleware. It matches only `/cosmos` and `/evm`, and is mounted before the
 * app's own `/api` router, so every pre-existing route behaves exactly as before. Remove the
 * single `app.use(nexoraProxy)` line in app.ts and the server is back to its original shape.
 *
 * Why it exists: the NEXORA validators bind loopback only. Replit's dev domain already
 * publishes this server to the internet, so proxying here is what gives the chain a public
 * endpoint without a paid plan.
 *
 * READ ONLY, deliberately. The application endpoint on node0's own port is NOT proxied, so
 * this cannot sign, submit or broadcast. A transaction is sent from the operator's machine.
 */
import type { Request, Response, NextFunction } from "express";
import http from "node:http";

const COMET = { host: "127.0.0.1", port: 26657 };
const EVM = { host: "127.0.0.1", port: 8545 };

function forward(
  target: { host: string; port: number },
  req: Request,
  res: Response,
  pathWithQuery: string,
) {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);

    // Forward the client's request headers, minus hop-by-hop ones. Accept-Encoding in
    // particular MUST be passed through, because geth's RPC server honours it and replies
    // gzip-encoded when asked.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (["host", "connection", "content-length", "transfer-encoding"].includes(k)) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    headers["content-type"] = req.headers["content-type"] ?? "application/json";
    headers["content-length"] = String(body.length);

    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        path: pathWithQuery,
        method: req.method,
        headers,
        timeout: 30000,
      },
      (r) => {
        res.status(r.statusCode ?? 502);
        // Copy the upstream headers THROUGH, not just content-type. The previous version
        // forwarded content-type only, so a gzip-encoded response arrived with gzip bytes
        // and no content-encoding header — every client that negotiated compression then
        // tried to parse compressed data as JSON and failed. curl without
        // Accept-Encoding was unaffected, which is exactly why this stayed hidden.
        for (const [k, v] of Object.entries(r.headers)) {
          if (v === undefined) continue;
          if (["connection", "transfer-encoding", "keep-alive"].includes(k)) continue;
          res.setHeader(k, v as string);
        }
        r.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", (e) => {
      if (!res.headersSent) {
        res.status(502).json({
          error: "nexora_upstream_unreachable",
          detail: String(e.message),
          hint: "are the four validators running?",
        });
      }
    });
    if (body.length) upstream.write(body);
    upstream.end();
  });
}

/**
 * Returns true when the request was handled here.
 *
 * Paths are nested under `/api/nexora/` on purpose. Replit's dev domain forwards ONLY the
 * `/api/*` and `/__mockup/*` prefixes to this server — anything else comes back as
 * "Backend Not Configured" from Replit's router, before it ever reaches the process. So the
 * chain has to live under a prefix the router already forwards. This middleware is mounted
 * ahead of the app's own router, so `/api/nexora/*` is claimed here and never reaches it.
 */
const PREFIX = "/api/nexora";

export function nexoraProxy(req: Request, res: Response, next: NextFunction): void {
  const url = req.url ?? "";
  if (!url.startsWith(PREFIX)) {
    next();
    return;
  }
  const rest = url.slice(PREFIX.length) || "/";

  if (req.method === "GET" && (rest === "/info" || rest === "/info/")) {
    let genesisSha256: string | null = null;
    try {
      const { createHash } = require("node:crypto") as typeof import("node:crypto");
      const fs = require("node:fs") as typeof import("node:fs");
      const p =
        process.env["NEXORA_GENESIS_FILE"] ??
        "/home/runner/workspace/nexora-chain/testnet/genesis.json";
      genesisSha256 = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    } catch {
      genesisSha256 = null;
    }
    // The public origin, so a client reading this does not have to infer it. Replit's
    // dev-domain host is the only externally reachable name; everything else is loopback.
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

      // Absolute public URLs. `/cosmos/status` reports `listen_addr: 127.0.0.1:26656`
      // and `rpc_address: tcp://127.0.0.1:26657`, and that is CORRECT, not a defect:
      // those are CometBFT's own loopback sockets. The container is behind NAT and binds
      // loopback only, so advertising anything else would be a lie — and worse, CometBFT
      // would then try to LISTEN on that name and the four-node mesh would collapse.
      // External access arrives through this gateway, which terminates TLS in front.
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

      // What a client actually supplies to a wallet.
      wallet: {
        networkName: "NEXORA Testnet",
        chainId: 902024,
        chainIdHex: "0xdc388",
        currencySymbol: "ANEX",
        decimals: 18,
        rpcUrl: host ? `https://${host}${PREFIX}/evm` : null,
      },

      // Honest capability statement.
      capabilities: {
        cosmosSide: "read-only CometBFT endpoints",
        evmSide: "full JSON-RPC forwarded, including eth_sendRawTransaction",
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

  if (rest.startsWith("/cosmos/")) {
    forward(COMET, req, res, rest.slice("/cosmos".length));
    return;
  }
  if (rest === "/evm" || rest.startsWith("/evm/")) {
    forward(EVM, req, res, rest.slice("/evm".length) || "/");
    return;
  }

  next();
}