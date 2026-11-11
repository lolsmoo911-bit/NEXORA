/**
 * NEXORA testnet — authenticated reverse proxy to the local OpenCode web UI.
 *
 * SECURITY MODEL
 * --------------
 * This proxy is DISABLED unless `OPENCODE_PROXY_ENABLED` is explicitly true.
 * When enabled, every HTTP request and WebSocket upgrade must present
 * `Authorization: Bearer <OPENCODE_PROXY_TOKEN>` where the token is at least
 * 32 characters. The comparison is constant-time and the client token is never
 * forwarded upstream.
 *
 * The upstream OpenCode Basic password is injected server-side only. It is NOT
 * client authentication, and it is never returned to browser-side code.
 *
 * If the proxy is enabled without a strong token it fails closed with 503. If
 * it is disabled, requests fall through to the rest of the Express app.
 */
import type { Request, Response, NextFunction } from "express";
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TARGET = "http://127.0.0.1:49374";
const MIN_TOKEN_LENGTH = 32;
const ENABLED_VALUES = /^(1|true|yes|on)$/i;

function targetUrl(): URL {
  return new URL(
    process.env["OPENCODE_WEB_URL"] ??
      process.env["OPENCODE_BASE_URL"] ??
      DEFAULT_TARGET,
  );
}

/**
 * The upstream OpenCode server's password.
 *
 * Read from the environment when set, otherwise straight from OpenCode's own
 * service.json. This is a server-to-server credential; it must never be sent to
 * a client or written to a log.
 */
let cachedFilePassword: string | null | undefined;
function upstreamPassword(): string | null {
  const fromEnv = process.env["OPENCODE_WEB_PASSWORD"];
  if (fromEnv) return fromEnv;
  if (cachedFilePassword !== undefined) return cachedFilePassword;
  try {
    const configHome =
      process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
    const raw = readFileSync(join(configHome, "opencode", "service.json"), "utf8");
    const parsed = JSON.parse(raw) as { password?: unknown };
    cachedFilePassword =
      typeof parsed.password === "string" && parsed.password.length > 0
        ? parsed.password
        : null;
  } catch {
    cachedFilePassword = null;
  }
  return cachedFilePassword;
}

function proxyEnabled(): boolean {
  return ENABLED_VALUES.test((process.env["OPENCODE_PROXY_ENABLED"] ?? "").trim());
}

/** The configured client token, or null when it is missing or too weak. */
function clientToken(): string | null {
  const token = process.env["OPENCODE_PROXY_TOKEN"]?.trim();
  if (!token || token.length < MIN_TOKEN_LENGTH) return null;
  return token;
}

function bearerFrom(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers["authorization"];
  if (typeof raw !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * Compare two secrets without leaking their contents through timing. Hashing
 * first keeps the comparison length constant even when the supplied token has a
 * different length.
 */
function tokensMatch(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

function authorized(
  headers: Record<string, string | string[] | undefined>,
  expected: string,
): boolean {
  const provided = bearerFrom(headers);
  return provided !== null && tokensMatch(provided, expected);
}

function rejectHttp(
  res: Response,
  status: number,
  error: string,
  detail?: string,
): void {
  if (status === 401) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="opencode"');
  }
  res.status(status).json(detail ? { error, detail } : { error });
}

function forward(req: Request, res: Response, target: URL, body: Buffer): void {
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
  headers["host"] = target.host;
  headers["content-length"] = String(body.length);

  // Inject the upstream's loopback-only credential. This is not client auth.
  const pw = upstreamPassword();
  if (pw) {
    headers["authorization"] =
      "Basic " + Buffer.from(`opencode:${pw}`).toString("base64");
  }

  const upstream = http.request(
    {
      host: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: req.url ?? "/",
      method: req.method,
      headers,
      timeout: 300000,
    },
    (r) => {
      res.status(r.statusCode ?? 502);
      for (const [k, v] of Object.entries(r.headers)) {
        if (v === undefined) continue;
        if (
          [
            "connection",
            "transfer-encoding",
            "keep-alive",
            "set-cookie",
          ].includes(k)
        ) {
          continue;
        }
        res.setHeader(k, v as string);
      }
      // OpenCode responses can contain session data. Do not let a shared cache
      // retain them, and never expose upstream session cookies to the client.
      res.setHeader("cache-control", "no-store");
      const ctype = String(r.headers["content-type"] ?? "");
      if (ctype.includes("text/event-stream")) {
        // SSE must never be buffered: the OpenCode web UI stays on "Loading"
        // until it receives the first `server.connected` event.
        res.setHeader("x-accel-buffering", "no");
        res.setHeader(
          "cache-control",
          "no-cache, no-transform, no-store, must-revalidate",
        );
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
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.status(502).json({
        error: "opencode_upstream_unreachable",
        detail: "upstream request failed",
      });
    }
  });
  if (body.length) upstream.write(body);
  upstream.end();
}

function rewriteOpenCodePath(url: string): string {
  // Allow a dedicated public prefix (/opencode) for the OpenCode web UI. Strip
  // it before forwarding so the upstream receives its native root paths.
  if (!url.startsWith("/opencode")) return url;
  let rest = url.slice("/opencode".length);
  if (rest === "" || rest.startsWith("?")) rest = "/" + rest;
  return rest;
}

export function opencodeProxy(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const url = req.url ?? "";

  // NEXORA chain endpoints and the faucet keep their own handlers.
  if (url.startsWith("/api/nexora")) {
    next();
    return;
  }

  // Default is OFF. A disabled proxy must never forward to OpenCode.
  if (!proxyEnabled()) {
    next();
    return;
  }

  const expected = clientToken();
  if (!expected) {
    rejectHttp(
      res,
      503,
      "opencode_proxy_misconfigured",
      "OPENCODE_PROXY_TOKEN must be set to at least 32 characters when the proxy is enabled.",
    );
    return;
  }

  if (!authorized(req.headers, expected)) {
    rejectHttp(res, 401, "unauthorized");
    return;
  }

  // The OpenCode UI is a root-routed SPA; serving it under /opencode makes its
  // client router throw "Unrecognised route". Redirect the authenticated entry
  // point to "/", which is also forwarded to this server.
  if (
    url === "/opencode" ||
    url.startsWith("/opencode?") ||
    url === "/opencode/"
  ) {
    const q = url.includes("?") ? url.slice(url.indexOf("?")) : "";
    res.redirect(302, "/" + q);
    return;
  }

  (req as { url: string }).url = rewriteOpenCodePath(url);

  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => forward(req, res, targetUrl(), Buffer.concat(chunks)));
  req.on("error", () => {
    if (!res.headersSent) {
      res.status(400).json({ error: "bad_request" });
    }
  });
}

type UpgradeRequest = {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  method?: string;
};

type UpgradeSocket = NodeJS.WritableStream & {
  write: (data: any) => boolean;
  destroy: (err?: Error) => void;
  pipe: (dest: any) => any;
};

function writeUpgradeError(
  socket: UpgradeSocket,
  status: number,
  error: string,
): void {
  const body = JSON.stringify({ error });
  const reason =
    status === 401
      ? "Unauthorized"
      : status === 503
        ? "Service Unavailable"
        : "Not Found";
  const auth =
    status === 401 ? 'WWW-Authenticate: Bearer realm="opencode"\r\n' : "";
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      auth +
      "\r\n" +
      body,
  );
  socket.destroy();
}

/**
 * Forward WebSocket upgrades (OpenCode's event stream) to the same target.
 * Returns true when the upgrade was handled here, including rejection.
 */
export function handleOpencodeUpgrade(
  req: UpgradeRequest,
  socket: UpgradeSocket,
  head: Buffer,
  target: URL = targetUrl(),
): boolean {
  const url = req.url ?? "";
  if (url.startsWith("/api/nexora")) return false;

  if (!proxyEnabled()) {
    writeUpgradeError(socket, 404, "opencode_proxy_disabled");
    return true;
  }

  const expected = clientToken();
  if (!expected) {
    writeUpgradeError(socket, 503, "opencode_proxy_misconfigured");
    return true;
  }

  if (!authorized(req.headers, expected)) {
    writeUpgradeError(socket, 401, "unauthorized");
    return true;
  }

  (req as { url?: string }).url = rewriteOpenCodePath(url);

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
  headers["host"] = target.host;
  headers["connection"] = "Upgrade";
  headers["upgrade"] = "websocket";

  const pw = upstreamPassword();
  if (pw) {
    headers["authorization"] =
      "Basic " + Buffer.from(`opencode:${pw}`).toString("base64");
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
      if (k.toLowerCase() === "set-cookie") continue;
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
      if (k.toLowerCase() === "set-cookie") continue;
      statusLine += `${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`;
    }
    socket.write(statusLine + "\r\n");
    r.pipe(socket);
  });

  proxyReq.on("error", () => socket.destroy());
  proxyReq.end();
  return true;
}
