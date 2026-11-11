import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createNexoraProxy } from "../src/nexoraProxy.ts";

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

/**
 * Send a literal request path without fetch/URL dot-segment normalization, so
 * traversal-shaped input actually reaches the proxy.
 */
function rawGet(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function createUpstream(): { server: http.Server; hits: Hit[] } {
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
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }));
    });
  });
  return { server, hits };
}

describe("nexoraProxy read-only enforcement", () => {
  let comet: http.Server;
  let evm: http.Server;
  let cometHits: Hit[];
  let evmHits: Hit[];
  let appServer: http.Server;
  let appPort: number;
  let cometPort: number;
  let evmPort: number;

  beforeEach(async () => {
    const c = createUpstream();
    const e = createUpstream();
    comet = c.server;
    cometHits = c.hits;
    evm = e.server;
    evmHits = e.hits;
    cometPort = await listen(comet);
    evmPort = await listen(evm);

    const app = express();
    app.use(
      createNexoraProxy({
        comet: { host: "127.0.0.1", port: cometPort },
        evm: { host: "127.0.0.1", port: evmPort },
      }),
    );
    app.use((_req, res) => {
      res.status(404).json({ error: "app_fallthrough" });
    });
    appServer = http.createServer(app);
    appPort = await listen(appServer);
  });

  afterEach(async () => {
    await closeServer(appServer);
    await closeServer(comet);
    await closeServer(evm);
  });

  async function postEvm(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`http://127.0.0.1:${appPort}/api/nexora/evm`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  async function postComet(body: unknown) {
    return fetch(`http://127.0.0.1:${appPort}/api/nexora/cosmos/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("forwards allowed EVM reads", async () => {
    const methods = [
      "eth_chainId",
      "eth_blockNumber",
      "eth_gasPrice",
      "eth_getBalance",
      "eth_call",
      "eth_estimateGas",
      "eth_getBlockByNumber",
      "eth_getTransactionReceipt",
      "eth_getLogs",
      "eth_getProof",
      "net_version",
      "web3_clientVersion",
    ];
    for (const method of methods) {
      const res = await postEvm({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: [],
      });
      assert.equal(res.status, 200, method);
    }
    assert.equal(evmHits.length, methods.length);
    assert.equal(evmHits[0]?.url, "/");
  });

  it("forwards a batch when every entry is a read", async () => {
    const body = [
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
    ];
    const res = await postEvm(body);
    assert.equal(res.status, 200);
    assert.equal(evmHits.length, 1);
    assert.deepEqual(JSON.parse(evmHits[0]?.body ?? "null"), body);
  });

  it("rejects transaction submission, signing, admin and mutation methods", async () => {
    const blocked = [
      "eth_sendRawTransaction",
      "eth_sendTransaction",
      "eth_sign",
      "eth_signTransaction",
      "personal_unlockAccount",
      "personal_sendTransaction",
      "admin_addPeer",
      "debug_traceTransaction",
      "miner_start",
      "engine_newPayloadV3",
      "eth_newFilter",
      "eth_newBlockFilter",
      "eth_uninstallFilter",
      "eth_subscribe",
      "txpool_content",
    ];
    for (const method of blocked) {
      const res = await postEvm({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: [],
      });
      assert.equal(res.status, 403, method);
      assert.equal((await res.json()).error, "method_not_allowed");
    }
    assert.equal(evmHits.length, 0);
  });

  it("rejects a batch containing one write, without forwarding the read", async () => {
    const res = await postEvm([
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "eth_sendRawTransaction",
        params: ["0xdeadbeef"],
      },
    ]);
    assert.equal(res.status, 403);
    assert.equal(evmHits.length, 0);
  });

  it("rejects unknown EVM methods by default", async () => {
    const res = await postEvm({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_someFutureWriteMethod",
      params: [],
    });
    assert.equal(res.status, 403);
    assert.equal(evmHits.length, 0);
  });

  it("rejects malformed JSON and GET on the EVM endpoint", async () => {
    const malformed = await fetch(
      `http://127.0.0.1:${appPort}/api/nexora/evm`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      },
    );
    assert.equal(malformed.status, 400);
    assert.equal(evmHits.length, 0);

    const get = await fetch(`http://127.0.0.1:${appPort}/api/nexora/evm`);
    assert.equal(get.status, 405);
    assert.equal(evmHits.length, 0);
  });

  it("forwards allowed CometBFT GET paths", async () => {
    const status = await fetch(
      `http://127.0.0.1:${appPort}/api/nexora/cosmos/status`,
    );
    assert.equal(status.status, 200);

    const block = await fetch(
      `http://127.0.0.1:${appPort}/api/nexora/cosmos/block?height=1`,
    );
    assert.equal(block.status, 200);

    assert.equal(cometHits.length, 2);
    assert.equal(cometHits[0]?.url, "/status");
    assert.equal(cometHits[1]?.url, "/block?height=1");
  });

  it("forwards allowed CometBFT JSON-RPC POST methods", async () => {
    const res = await postComet({
      jsonrpc: "2.0",
      id: 1,
      method: "status",
      params: [],
    });
    assert.equal(res.status, 200);
    assert.equal(cometHits.length, 1);
    assert.equal(cometHits[0]?.url, "/");
  });

  it("rejects broadcast_tx_* and administrative CometBFT methods", async () => {
    const blocked = [
      "broadcast_tx_sync",
      "broadcast_tx_async",
      "broadcast_tx_commit",
      "unsafe_flush_mempool",
      "dial_seeds",
      "dial_peers",
      "unsubscribe",
      "check_tx",
      "flush_mempool",
    ];
    for (const method of blocked) {
      const res = await postComet({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: [],
      });
      assert.equal(res.status, 403, method);
    }
    assert.equal(cometHits.length, 0);
  });

  it("rejects a CometBFT batch containing one broadcast", async () => {
    const res = await postComet([
      { jsonrpc: "2.0", id: 1, method: "status", params: [] },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "broadcast_tx_commit",
        params: ["0xdeadbeef"],
      },
    ]);
    assert.equal(res.status, 403);
    assert.equal(cometHits.length, 0);
  });

  it("rejects write-shaped CometBFT GET paths", async () => {
    const blocked = [
      "broadcast_tx_commit",
      "broadcast_tx_sync",
      "unsafe_flush_mempool",
      "dial_seeds",
      "subscribe",
    ];
    for (const path of blocked) {
      const res = await fetch(
        `http://127.0.0.1:${appPort}/api/nexora/cosmos/${path}`,
      );
      assert.equal(res.status, 403, path);
    }
    assert.equal(cometHits.length, 0);
  });

  it("rejects traversal-shaped CometBFT paths", async () => {
    // fetch() normalizes dot segments, so send the raw path over http.request.
    const encoded = await rawGet(
      appPort,
      "/api/nexora/cosmos/%2e%2e/status",
    );
    assert.equal(encoded, 400);

    const literal = await rawGet(
      appPort,
      "/api/nexora/cosmos/../status",
    );
    assert.equal(literal, 400);

    assert.equal(cometHits.length, 0);
  });

  it("does not forward client credentials to the node", async () => {
    const res = await postEvm(
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      {
        authorization: "Bearer node-must-not-see-this",
        cookie: "app_session=must-not-leak",
      },
    );
    assert.equal(res.status, 200);
    assert.equal(evmHits.length, 1);
    assert.equal(evmHits[0]?.headers.authorization, undefined);
    assert.equal(evmHits[0]?.headers.cookie, undefined);
  });

  it("returns an honest read-only capability statement", async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/api/nexora/info`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.capabilities.evmSide, /read-only/i);
    assert.match(body.capabilities.evmSide, /blocked/i);
    assert.equal(body.capabilities.writeMethods, "blocked by default");
    assert.equal(evmHits.length + cometHits.length, 0);
  });

  it("does not echo client credentials in a rejection", async () => {
    const secret = "node-must-not-see-this";
    const res = await postEvm(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: ["0xdeadbeef"],
      },
      { authorization: `Bearer ${secret}` },
    );
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.ok(!text.includes(secret));
  });
});
