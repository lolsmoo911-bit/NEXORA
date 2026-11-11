import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { PassThrough } from "node:stream";
import {
  handleOpencodeUpgrade,
  opencodeProxy,
} from "../src/opencodeProxy.ts";

const TOKEN = "test-client-token-0123456789abcdef";
const UPSTREAM_PASSWORD = "upstream-basic-secret";

interface Hit {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("server has no TCP address"));
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function createUpstream(
  handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): { server: http.Server; hits: Hit[] } {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      hits.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (handler) {
        handler(req, res);
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return { server, hits };
}

function fakeSocket(): {
  chunks: Buffer[];
  write: (data: unknown) => boolean;
  destroy: () => void;
  pipe: () => unknown;
  on: () => unknown;
} {
  const chunks: Buffer[] = [];
  return {
    chunks,
    write(data: unknown) {
      chunks.push(Buffer.from(String(data)));
      return true;
    },
    destroy() {
      /* no-op for rejection tests */
    },
    pipe() {
      return this;
    },
    on() {
      return this;
    },
  };
}

describe("opencodeProxy", () => {
  let upstream: http.Server;
  let upstreamHits: Hit[];
  let appServer: http.Server;
  let appPort: number;
  let upstreamPort: number;

  beforeEach(async () => {
    delete process.env["OPENCODE_PROXY_ENABLED"];
    delete process.env["OPENCODE_PROXY_TOKEN"];
    delete process.env["OPENCODE_WEB_URL"];
    delete process.env["OPENCODE_WEB_PASSWORD"];

    const up = createUpstream();
    upstream = up.server;
    upstreamHits = up.hits;
    upstreamPort = await listen(upstream);
    process.env["OPENCODE_WEB_URL"] = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    app.use(opencodeProxy);
    app.use((_req, res) => {
      res.status(404).json({ error: "app_fallthrough" });
    });
    appServer = http.createServer(app);
    appPort = await listen(appServer);
  });

  afterEach(async () => {
    await closeServer(appServer);
    await closeServer(upstream);
    delete process.env["OPENCODE_PROXY_ENABLED"];
    delete process.env["OPENCODE_PROXY_TOKEN"];
    delete process.env["OPENCODE_WEB_URL"];
    delete process.env["OPENCODE_WEB_PASSWORD"];
  });

  it("is disabled by default and does not forward", async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "app_fallthrough");
    assert.equal(upstreamHits.length, 0);
  });

  it("fails closed when enabled without a token", async () => {
    process.env["OPENCODE_PROXY_ENABLED"] = "true";
    const res = await fetch(`http://127.0.0.1:${appPort}/`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "opencode_proxy_misconfigured");
    assert.equal(upstreamHits.length, 0);
  });

  it("fails closed when the token is shorter than 32 characters", async () => {
    process.env["OPENCODE_PROXY_ENABLED"] = "true";
    process.env["OPENCODE_PROXY_TOKEN"] = "too-short";
    const res = await fetch(`http://127.0.0.1:${appPort}/`);
    assert.equal(res.status, 503);
    assert.equal(upstreamHits.length, 0);
  });

  it("rejects UI and API requests with no bearer token", async () => {
    process.env["OPENCODE_PROXY_ENABLED"] = "true";
    process.env["OPENCODE_PROXY_TOKEN"] = TOKEN;
    for (const path of ["/", "/api/session", "/api/file", "/api/shell"]) {
      const res = await fetch(`http://127.0.0.1:${appPort}${path}`);
      assert.equal(res.status, 401, path);
      assert.match(String(res.headers.get("www-authenticate")), /^Bearer /);
      assert.equal((await res.json()).error, "unauthorized");
    }
    assert.equal(upstreamHits.length, 0);
  });

  it("rejects a request with the wrong bearer token", async () => {
    process.env["OPENCODE_PROXY_ENABLED"] = "true";
    process.env["OPENCODE_PROXY_TOKEN"] = TOKEN;
    const res = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
      headers: { authorization: `Bearer ${"x".repeat(TOKEN.length)}` },
    });
    assert.equal(res.status, 401);
    assert.equal(upstreamHits.length, 0);
  });

  it("never intercepts /api/nexora chain endpoints", async () => {
    process.env["OPENCODE_PROXY_ENABLED"] = "true";
    process.env["OPENCODE_PROXY_TOKEN"] = TOKEN;
    const res = await fetch(`http://127.0.0.1:${appPort}/api/nexora/evm`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "app_fallthrough");
    assert.equal(upstreamHits.length, 0);
  });

  it("forwards an authorized request and injects upstream Basic auth", async () => {
    process.env["OPENCODE_PROXY_ENABLED"] = "true";
    process.env["OPENCODE_PROXY_TOKEN"] = TOKEN;
    process.env["OPENCODE_WEB_PASSWORD"] = UPSTREAM_PASSWORD;

    const res = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        cookie: "app_session=must-not-leak",
      },
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"ok":true/);
    assert.equal(upstreamHits.length, 1);

    const upstreamAuth = String(upstreamHits[0]?.headers.authorization ?? "");
    assert.match(upstreamAuth, /^Basic /);
    assert.equal(
      Buffer.from(upstreamAuth.slice("Basic ".length), "base64").toString("utf8"),
      `opencode:${UPSTREAM_PASSWORD}`,
    );
    assert.equal(upstreamHits[0]?.headers.cookie, undefined);
    assert.ok(!text.includes(TOKEN));
    assert.ok(!text.includes(UPSTREAM_PASSWORD));
  });

  it("strips upstream session cookies and marks responses no-store", async () => {
    process.env["OPENCODE_PROXY_ENABLED"] = "true";
    process.env["OPENCODE_PROXY_TOKEN"] = TOKEN;

    await closeServer(upstream);
    const withCookie = createUpstream((_req, res) => {
      res.setHeader("set-cookie", "opencode_session=must-not-reach-browser");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    upstream = withCookie.server;
    upstreamHits = withCookie.hits;
    upstreamPort = await listen(upstream);
    process.env["OPENCODE_WEB_URL"] = `http://127.0.0.1:${upstreamPort}`;

    const res = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("set-cookie"), null);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(upstreamHits.length, 1);
  });

  it("streams SSE only after authentication", async () => {
    process.env["OPENCODE_PROXY_ENABLED"] = "true";
    process.env["OPENCODE_PROXY_TOKEN"] = TOKEN;

    await closeServer(upstream);
    const sse = createUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      res.end("data: two\n\n");
    });
    upstream = sse.server;
    upstreamHits = sse.hits;
    upstreamPort = await listen(upstream);
    process.env["OPENCODE_WEB_URL"] = `http://127.0.0.1:${upstreamPort}`;

    const unauthorized = await fetch(`http://127.0.0.1:${appPort}/event`);
    assert.equal(unauthorized.status, 401);
    assert.equal(upstreamHits.length, 0);

    const authorized = await fetch(`http://127.0.0.1:${appPort}/event`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(authorized.status, 200);
    const text = await authorized.text();
    assert.match(text, /data: one/);
    assert.match(text, /data: two/);
    assert.equal(upstreamHits.length, 1);
  });

  it("does not leak secrets when the upstream is unreachable", async () => {
    process.env["OPENCODE_PROXY_ENABLED"] = "true";
    process.env["OPENCODE_PROXY_TOKEN"] = TOKEN;
    process.env["OPENCODE_WEB_PASSWORD"] = UPSTREAM_PASSWORD;
    process.env["OPENCODE_WEB_URL"] = "http://127.0.0.1:1";

    const res = await fetch(`http://127.0.0.1:${appPort}/api/session`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.ok(!text.includes(TOKEN));
    assert.ok(!text.includes(UPSTREAM_PASSWORD));
  });
});

describe("handleOpencodeUpgrade", () => {
  beforeEach(() => {
    delete process.env["OPENCODE_PROXY_ENABLED"];
    delete process.env["OPENCODE_PROXY_TOKEN"];
  });

  afterEach(() => {
    delete process.env["OPENCODE_PROXY_ENABLED"];
    delete process.env["OPENCODE_PROXY_TOKEN"];
  });

  it("rejects upgrades when the proxy is disabled", () => {
    const socket = fakeSocket();
    const handled = handleOpencodeUpgrade(
      { url: "/event", headers: {}, method: "GET" },
      socket as never,
      Buffer.alloc(0),
    );
    assert.equal(handled, true);
    assert.match(socket.chunks.join(""), /HTTP\/1\.1 404/);
  });

  it("rejects upgrades when enabled without a token", () => {
    process.env["OPENCODE_PROXY_ENABLED"] = "true";
    const socket = fakeSocket();
    const handled = handleOpencodeUpgrade(
      { url: "/event", headers: {}, method: "GET" },
      socket as never,
      Buffer.alloc(0),
    );
    assert.equal(handled, true);
    assert.match(socket.chunks.join(""), /HTTP\/1\.1 503/);
  });

  it("rejects unauthenticated upgrades", () => {
    process.env["OPENCODE_PROXY_ENABLED"] = "true";
    process.env["OPENCODE_PROXY_TOKEN"] = TOKEN;
    const socket = fakeSocket();
    const handled = handleOpencodeUpgrade(
      { url: "/event", headers: {}, method: "GET" },
      socket as never,
      Buffer.alloc(0),
    );
    assert.equal(handled, true);
    assert.match(socket.chunks.join(""), /HTTP\/1\.1 401/);
    assert.match(socket.chunks.join(""), /WWW-Authenticate: Bearer/);
  });

  it("forwards an authenticated upgrade without leaking the client token", async () => {
    process.env["OPENCODE_PROXY_ENABLED"] = "true";
    process.env["OPENCODE_PROXY_TOKEN"] = TOKEN;
    process.env["OPENCODE_WEB_PASSWORD"] = UPSTREAM_PASSWORD;

    const upgradeHeaders: http.IncomingHttpHeaders[] = [];
    const upstream = http.createServer();
    upstream.on("upgrade", (req, socket) => {
      upgradeHeaders.push(req.headers);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n\r\n",
      );
      socket.end();
    });
    const port = await listen(upstream);

    const socket = new PassThrough();
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));

    const handled = handleOpencodeUpgrade(
      {
        url: "/event",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          cookie: "app_session=must-not-leak",
          connection: "Upgrade",
          upgrade: "websocket",
        },
        method: "GET",
      },
      socket as never,
      Buffer.alloc(0),
      new URL(`http://127.0.0.1:${port}`),
    );
    assert.equal(handled, true);

    if (chunks.length === 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("upgrade response timed out")),
          2000,
        );
        socket.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    assert.match(chunks.join(""), /101 Switching Protocols/);
    assert.equal(upgradeHeaders.length, 1);
    const upstreamAuth = String(upgradeHeaders[0]?.authorization ?? "");
    assert.match(upstreamAuth, /^Basic /);
    assert.ok(!upstreamAuth.includes(TOKEN));
    assert.equal(upgradeHeaders[0]?.cookie, undefined);

    socket.destroy();
    await closeServer(upstream);
    delete process.env["OPENCODE_WEB_PASSWORD"];
  });
});
