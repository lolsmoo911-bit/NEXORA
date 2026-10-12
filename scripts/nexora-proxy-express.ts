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
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        path: pathWithQuery,
        method: req.method,
        headers: {
          "content-type": req.headers["content-type"] ?? "application/json",
        },
        timeout: 30000,
      },
      (r) => {
        res.status(r.statusCode ?? 502);
        const ct = r.headers["content-type"];
        if (ct) res.setHeader("content-type", ct);
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
      const p = process.env["NEXORA_GENESIS_FILE"] ?? "/tmp/opencode/nexora-testnet/genesis.json";
      genesisSha256 = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    } catch {
      genesisSha256 = null;
    }
    res.json({
      chain: {
        cosmosChainId: "nexora-devnet-1",
        evmChainId: 902024,
        evmChainIdHex: "0xdc388",
        denom: "anex",
        decimals: 18,
      },
      genesisSha256,
      endpoints: {
        cosmos: `${PREFIX}/cosmos/status`,
        evm: `${PREFIX}/evm`,
      },
      readOnly: true,
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