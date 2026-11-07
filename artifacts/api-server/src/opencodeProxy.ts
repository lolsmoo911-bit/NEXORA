/**
 * NEXORA testnet — public reverse proxy to the local OpenCode web UI.
 *
 * OpenCode's `serve` web server binds loopback only (and on a port that changes
 * between restarts). Running it on a *stable* loopback port (see
 * OPENCODE_WEB_URL / OPENCODE_BASE_URL, default http://127.0.0.1:4096) lets us
 * publish its UI through the same Replit dev domain as the chain, without
 * giving it its own inbound port on the free plan.
 *
 * Ordering contract (see app.ts): this runs AFTER nexoraProxy and BEFORE body
 * parsers. It claims everything nexoraProxy declines, so the NEXORA endpoints
 * (/api/nexora/*) keep their own handling, while the rest of the public
 * surface is forwarded to OpenCode. That keeps the two projects from mixing.
 */
import type { Request, Response, NextFunction } from "express";
import http from "node:http";

const TARGET_URL = new URL(
  process.env["OPENCODE_WEB_URL"] ??
    process.env["OPENCODE_BASE_URL"] ??
    "http://127.0.0.1:49374",
);

/**
 * The upstream OpenCode server's password.
 *
 * Read from the environment when set, otherwise straight from opencode's own
 * service.json. Reading the file matters because this process is usually started
 * by Replit's artifact runner, which has no control over our env vars -- without
 * the fallback every proxied request would come back 401 and the web UI would
 * sit on "Loading" forever.
 */
let cachedPassword: string | null | undefined;
function upstreamPassword(): string | null {
  if (cachedPassword !== undefined) return cachedPassword;
  const fromEnv = process.env["OPENCODE_WEB_PASSWORD"];
  if (fromEnv) {
    cachedPassword = fromEnv;
    return cachedPassword;
  }
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const os = require("node:os") as typeof import("node:os");
    const file =
      process.env["XDG_CONFIG_HOME"] ??
      path.join(os.homedir(), ".config");
    const raw = fs.readFileSync(
      path.join(file, "opencode", "service.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { password?: unknown };
    cachedPassword =
      typeof parsed.password === "string" && parsed.password.length > 0
        ? parsed.password
        : null;
  } catch {
    cachedPassword = null;
  }
  return cachedPassword;
}

function forward(
  req: Request,
  res: Response,
  target: URL,
  body: Buffer,
): void {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (["host", "connection", "content-length", "transfer-encoding", "keep-alive", "authorization"].includes(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  headers["host"] = target.host;
  headers["content-length"] = String(body.length);
  // Inject the upstream's (loopback-only) auth so public clients don't have to.
  const pw = upstreamPassword();
  if (pw) {
    headers["authorization"] = "Basic " + Buffer.from(`opencode:${pw}`).toString("base64");
  }

  const upstream = http.request(
    {
      host: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: (req.url ?? "/"),
      method: req.method,
      headers,
      timeout: 300000,
    },
    (r) => {
      res.status(r.statusCode ?? 502);
      for (const [k, v] of Object.entries(r.headers)) {
        if (v === undefined) continue;
        if (["connection", "transfer-encoding", "keep-alive"].includes(k)) continue;
        res.setHeader(k, v as string);
      }
      const ctype = String(r.headers["content-type"] ?? "");
      if (ctype.includes("text/event-stream")) {
        // SSE must never be buffered: the OpenCode web UI stays on "Loading" until
        // it receives the first `server.connected` event. Disable proxy/edge
        // buffering and flush every chunk.
        res.setHeader("x-accel-buffering", "no");
        res.setHeader("cache-control", "no-cache, no-transform, no-store, must-revalidate");
        res.flushHeaders();
        r.on("data", (c: Buffer) => {
          res.write(c);
          (res as unknown as { flush?: () => void }).flush?.();
        });
        r.on("end", () => res.end());
      } else {
        r.pipe(res);
      }
    },
  );

  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (e) => {
    if (!res.headersSent) {
      res.status(502).json({
        error: "opencode_upstream_unreachable",
        detail: String(e.message),
        hint: "is the OpenCode web server running on the configured loopback port?",
        target: `${target.protocol}//${target.host}`,
      });
    }
  });
  if (body.length) upstream.write(body);
  upstream.end();
}

function rewriteOpenCodePath(url: string): string {
  // Allow a dedicated public prefix (/opencode) for the OpenCode web UI. Strip it
  // before forwarding so the upstream receives its native root paths; the response
  // assets stay under /_assets, which is also forwarded verbatim (see the
  // .replit-artifact manifest).
  if (!url.startsWith("/opencode")) return url;
  let rest = url.slice("/opencode".length);
  if (rest === "" || rest.startsWith("?")) rest = "/" + rest;
  return rest;
}

export function opencodeProxy(req: Request, res: Response, next: NextFunction): void {
  const url = req.url ?? "";
  // The OpenCode UI is a root-routed SPA; serving it under /opencode makes its
  // client router throw "Unrecognised route". Redirect the public entry point to
  // "/", which is now also forwarded to this server, and let it boot naturally.
  if (url === "/opencode" || url.startsWith("/opencode?") || url === "/opencode/") {
    const q = url.includes("?") ? url.slice(url.indexOf("?")) : "";
    res.redirect(302, "/" + q);
    return;
  }
  // Leave the NEXORA chain endpoints (and the faucet that hangs off them) to their
  // own handlers further down the stack.
  if (url.startsWith("/api/nexora")) {
    next();
    return;
  }

  // Rewrite the dedicated public prefix, in place, so forward() sees the native path.
  (req as { url: string }).url = rewriteOpenCodePath(url);

  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => forward(req, res, TARGET_URL, Buffer.concat(chunks)));
  req.on("error", (e) => {
    if (!res.headersSent) res.status(400).json({ error: "bad_request", detail: String(e.message) });
  });
}

/**
 * Forward WebSocket upgrades (OpenCode's event stream) to the same target.
 * Returns true when the upgrade was handled here.
 */
export function handleOpencodeUpgrade(
  req: { url?: string; headers: Record<string, string | string[] | undefined>; method?: string },
  socket: NodeJS.WritableStream & { write: (data: any) => boolean; destroy: (err?: Error) => void; pipe: (dest: any) => any },
  head: Buffer,
  target: URL = TARGET_URL,
): boolean {
  const url = req.url ?? "";
  if (url.startsWith("/api/nexora")) return false;
  (req as { url?: string }).url = rewriteOpenCodePath(url);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (["host", "connection", "content-length", "transfer-encoding", "keep-alive"].includes(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  headers["host"] = target.host;
  headers["connection"] = "Upgrade";
  headers["upgrade"] = "websocket";
  const pw = upstreamPassword();
  if (pw) {
    headers["authorization"] = "Basic " + Buffer.from(`opencode:${pw}`).toString("base64");
  }

  const proxyReq = http.request({
    host: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: (req.url as string) ?? url,
    method: req.method ?? "GET",
    headers,
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    let statusLine = `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (v === undefined) continue;
      statusLine += `${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`;
    }
    socket.write(statusLine + "\r\n");
    if (proxyHead && proxyHead.length) socket.write(proxyHead);
    if (head && head.length) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
  });

  proxyReq.on("response", (r) => {
    // A non-upgrade response to an upgrade request: forward it and close.
    let statusLine = `HTTP/${r.httpVersion} ${r.statusCode} ${r.statusMessage}\r\n`;
    for (const [k, v] of Object.entries(r.headers)) {
      if (v === undefined) continue;
      statusLine += `${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`;
    }
    socket.write(statusLine + "\r\n");
    r.pipe(socket);
  });

  proxyReq.on("error", () => socket.destroy());
  proxyReq.end();
  return true;
}

export const OPENCODE_TARGET = TARGET_URL;