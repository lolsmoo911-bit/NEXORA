import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTrustedProxyList,
  resolveClientAddress,
  clientKeyFor,
  redactFaucetErrorDetail,
  handleFaucet,
} from "../src/nexoraFaucet.ts";
import { createNexoraFaucetMount } from "../src/nexoraFaucetMount.ts";
import type { FaucetConfig } from "../src/nexoraFaucet.ts";
import {
  MemoryFaucetStore,
  type FakeFaucetRow,
} from "./helpers/faucetStore.ts";

const VALID_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const VALID_ADDR_2 = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const ANEX = 10n ** 18n;

function mockReq(overrides: Record<string, any> = {}) {
  return {
    method: "POST",
    headers: {},
    body: { address: VALID_ADDR },
    socket: { remoteAddress: "10.0.0.5" },
    url: "/api/nexora/faucet",
    ...overrides,
  } as any;
}

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

function cfg(overrides: Partial<FaucetConfig> = {}): FaucetConfig {
  return {
    opencode: { baseUrl: "http://127.0.0.1:4096" },
    faucetHome: "/tmp/test-home",
    faucetAccount: "dev3",
    faucetNode: "http://127.0.0.1:26657",
    faucetChainId: "eip155:902024",
    evmdPath: "evmd",
    store: new MemoryFaucetStore(),
    cooldownMs: 60_000,
    maxPerRequest: 1000n * ANEX,
    defaultPayout: 100n * ANEX,
    recipientDailyCap: 5000n * ANEX,
    dailyCap: 50_000n * ANEX,
    ...overrides,
  };
}

function countingRunner(delayMs = 0) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    run: async () => {
      calls += 1;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return {
        stdout: JSON.stringify({ txhash: `TX${calls}` }),
        stderr: "",
      };
    },
  };
}

describe("faucet client identity", () => {
  it("ignores X-Forwarded-For from an untrusted peer", () => {
    const trusted = buildTrustedProxyList([]);
    assert.equal(trusted.error, undefined);
    const req = mockReq({
      headers: { "x-forwarded-for": "203.0.113.9" },
      socket: { remoteAddress: "10.0.0.5" },
    });
    assert.equal(resolveClientAddress(req, trusted.list), "10.0.0.5");
  });

  it("normalises IPv4-mapped IPv6 socket addresses", () => {
    const req = mockReq({ socket: { remoteAddress: "::ffff:10.0.0.5" } });
    assert.equal(resolveClientAddress(req, null), "10.0.0.5");
  });

  it("derives an opaque client key instead of storing the raw address", () => {
    const key = clientKeyFor("203.0.113.9");
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!key.includes("203.0.113.9"));
    assert.notEqual(key, clientKeyFor("203.0.113.10"));
    assert.equal(key, clientKeyFor("203.0.113.9"));
  });

  it("fails closed when the socket address is unavailable", async () => {
    const store = new MemoryFaucetStore();
    const runner = countingRunner();
    const res = mockRes();
    await handleFaucet(
      mockReq({ socket: {}, body: { address: VALID_ADDR } }),
      res,
      cfg({ store, runner: runner.run }),
    );
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "faucet_client_unavailable");
    assert.equal(runner.calls, 0);
    assert.equal(store.rows.length, 0);
  });

  it("forged X-Forwarded-For cannot bypass the client cooldown", async () => {
    const store = new MemoryFaucetStore();
    const runner = countingRunner();
    const first = mockRes();
    await handleFaucet(
      mockReq({
        headers: { "x-forwarded-for": "198.51.100.1" },
        socket: { remoteAddress: "10.0.0.5" },
      }),
      first,
      cfg({ store, runner: runner.run }),
    );
    assert.equal(first.statusCode, 200);

    const second = mockRes();
    await handleFaucet(
      mockReq({
        headers: { "x-forwarded-for": "198.51.100.2" },
        socket: { remoteAddress: "10.0.0.5" },
      }),
      second,
      cfg({ store, runner: runner.run }),
    );
    assert.equal(second.statusCode, 429);
    assert.equal(second.body.error, "rate_limited");
    assert.equal(runner.calls, 1);
  });

  it("uses the rightmost untrusted X-Forwarded-For entry behind a trusted proxy", () => {
    const trusted = buildTrustedProxyList(["10.0.0.1"]);
    assert.equal(trusted.error, undefined);
    const req = mockReq({
      headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9" },
      socket: { remoteAddress: "10.0.0.1" },
    });
    assert.equal(resolveClientAddress(req, trusted.list), "203.0.113.9");
  });

  it("supports a trusted proxy CIDR", () => {
    const trusted = buildTrustedProxyList(["10.0.0.0/8"]);
    assert.equal(trusted.error, undefined);
    const req = mockReq({
      headers: { "x-forwarded-for": "203.0.113.10" },
      socket: { remoteAddress: "10.2.3.4" },
    });
    assert.equal(resolveClientAddress(req, trusted.list), "203.0.113.10");
  });

  it("does not trust X-Forwarded-For when the peer is outside the trusted list", () => {
    const trusted = buildTrustedProxyList(["10.0.0.1"]);
    assert.equal(trusted.error, undefined);
    const req = mockReq({
      headers: { "x-forwarded-for": "203.0.113.9" },
      socket: { remoteAddress: "10.0.0.2" },
    });
    assert.equal(resolveClientAddress(req, trusted.list), "10.0.0.2");
  });

  it("treats different trusted-proxy client identities independently", async () => {
    const trusted = buildTrustedProxyList(["10.0.0.1"]);
    const store = new MemoryFaucetStore();
    const runner = countingRunner();
    const make = (client: string) =>
      mockReq({
        headers: { "x-forwarded-for": client },
        socket: { remoteAddress: "10.0.0.1" },
      });

    const first = mockRes();
    await handleFaucet(
      make("203.0.113.9"),
      first,
      cfg({ store, runner: runner.run, trustedProxies: trusted.list }),
    );
    assert.equal(first.statusCode, 200);

    const second = mockRes();
    await handleFaucet(
      make("203.0.113.10"),
      second,
      cfg({ store, runner: runner.run, trustedProxies: trusted.list }),
    );
    assert.equal(second.statusCode, 200);

    const repeated = mockRes();
    await handleFaucet(
      make("203.0.113.9"),
      repeated,
      cfg({ store, runner: runner.run, trustedProxies: trusted.list }),
    );
    assert.equal(repeated.statusCode, 429);
    assert.equal(runner.calls, 2);
  });

  it("rejects a /0 trusted-proxy range", () => {
    const trusted = buildTrustedProxyList(["0.0.0.0/0"]);
    assert.equal(trusted.list, null);
    assert.match(String(trusted.error), /between 1 and 32/);
  });
});

describe("faucet durable budgets", () => {
  it("limits repeated requests to one wallet from different clients", async () => {
    const store = new MemoryFaucetStore();
    const runner = countingRunner();
    const config = cfg({
      store,
      runner: runner.run,
      recipientDailyCap: 150n * ANEX,
      dailyCap: 10_000n * ANEX,
    });

    const first = mockRes();
    await handleFaucet(
      mockReq({
        body: { address: VALID_ADDR },
        socket: { remoteAddress: "10.0.0.5" },
      }),
      first,
      config,
    );
    assert.equal(first.statusCode, 200);

    const second = mockRes();
    await handleFaucet(
      mockReq({
        body: { address: VALID_ADDR },
        socket: { remoteAddress: "10.0.0.6" },
      }),
      second,
      config,
    );
    assert.equal(second.statusCode, 429);
    assert.equal(second.body.error, "recipient_daily_limit");
    assert.equal(runner.calls, 1);
  });

  it("enforces the daily global cap across different wallets", async () => {
    const store = new MemoryFaucetStore();
    const runner = countingRunner();
    const config = cfg({
      store,
      runner: runner.run,
      recipientDailyCap: 10_000n * ANEX,
      dailyCap: 150n * ANEX,
    });

    const first = mockRes();
    await handleFaucet(
      mockReq({
        body: { address: VALID_ADDR },
        socket: { remoteAddress: "10.0.0.5" },
      }),
      first,
      config,
    );
    assert.equal(first.statusCode, 200);

    const second = mockRes();
    await handleFaucet(
      mockReq({
        body: { address: VALID_ADDR_2 },
        socket: { remoteAddress: "10.0.0.6" },
      }),
      second,
      config,
    );
    assert.equal(second.statusCode, 429);
    assert.equal(second.body.error, "faucet_daily_limit");
    assert.equal(runner.calls, 1);
  });

  it("concurrent payouts cannot bypass the daily cap", async () => {
    const store = new MemoryFaucetStore();
    const runner = countingRunner(25);
    const config = cfg({
      store,
      runner: runner.run,
      recipientDailyCap: 10_000n * ANEX,
      dailyCap: 150n * ANEX,
    });

    const responses = await Promise.all([
      (async () => {
        const res = mockRes();
        await handleFaucet(
          mockReq({
            body: { address: VALID_ADDR },
            socket: { remoteAddress: "10.0.0.5" },
          }),
          res,
          config,
        );
        return res;
      })(),
      (async () => {
        const res = mockRes();
        await handleFaucet(
          mockReq({
            body: { address: VALID_ADDR_2 },
            socket: { remoteAddress: "10.0.0.6" },
          }),
          res,
          config,
        );
        return res;
      })(),
    ]);

    assert.deepEqual(
      responses.map((res) => res.statusCode).sort(),
      [200, 429],
    );
    assert.equal(runner.calls, 1);
    assert.equal(store.rows.length, 1);
  });

  it("keeps the cooldown across a new store instance (process restart)", async () => {
    const rows: FakeFaucetRow[] = [];
    const firstStore = new MemoryFaucetStore({ rows });
    const runner = countingRunner();

    const first = mockRes();
    await handleFaucet(
      mockReq({ body: { address: VALID_ADDR } }),
      first,
      cfg({ store: firstStore, runner: runner.run }),
    );
    assert.equal(first.statusCode, 200);

    // A fresh store over the same durable rows models a process restart: there
    // is no module-level Map that could forget the previous request.
    const secondStore = new MemoryFaucetStore({ rows });
    const second = mockRes();
    await handleFaucet(
      mockReq({ body: { address: VALID_ADDR } }),
      second,
      cfg({ store: secondStore, runner: runner.run }),
    );
    assert.equal(second.statusCode, 429);
    assert.equal(second.body.error, "rate_limited");
    assert.equal(runner.calls, 1);
  });

  it("fails closed before evmd when the ledger is unavailable", async () => {
    const store = new MemoryFaucetStore();
    store.failNextReserve = true;
    const runner = countingRunner();
    const res = mockRes();
    await handleFaucet(
      mockReq({ body: { address: VALID_ADDR } }),
      res,
      cfg({ store, runner: runner.run }),
    );
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "faucet_ledger_unavailable");
    assert.equal(runner.calls, 0);
    assert.equal(store.rows.length, 0);
  });

  it("marks a reservation failed after an unexpected execution failure", async () => {
    const store = new MemoryFaucetStore();
    const res = mockRes();
    await handleFaucet(
      mockReq({ body: { address: VALID_ADDR } }),
      res,
      cfg({
        store,
        runner: async () => {
          throw new TypeError("unexpected error");
        },
      }),
    );
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error, "faucet_send_failed");
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0]?.status, "failed");
  });

  it("redacts credentials and long secrets from execution failures", async () => {
    const secretHex = "0123456789abcdef".repeat(4);
    const res = mockRes();
    await handleFaucet(
      mockReq({ body: { address: VALID_ADDR } }),
      res,
      cfg({
        store: new MemoryFaucetStore(),
        runner: async () => {
          const error = new Error("failed") as Error & { stderr: string };
          error.stderr =
            "Authorization: Bearer super-secret-token\n" +
            "Cookie: session=super-secret-cookie\n" +
            "password=hunter2\n" +
            `key=${secretHex}\n`;
          throw error;
        },
      }),
    );
    assert.equal(res.statusCode, 502);
    assert.ok(!res.body.detail.includes("super-secret-token"));
    assert.ok(!res.body.detail.includes("super-secret-cookie"));
    assert.ok(!res.body.detail.includes("hunter2"));
    assert.ok(!res.body.detail.includes(secretHex));
    assert.ok(res.body.detail.includes("[redacted]"));
    assert.equal(
      redactFaucetErrorDetail("Authorization: Bearer abc"),
      "Authorization=[redacted]",
    );
  });
});

describe("faucet mount configuration", () => {
  it("fails closed on an overly broad trusted-proxy configuration", async () => {
    const store = new MemoryFaucetStore();
    const mount = createNexoraFaucetMount({
      env: {
        OPENCODE_BASE_URL: "http://127.0.0.1:4096",
        NEXORA_FAUCET_HOME: "/tmp/test-home",
        NEXORA_FAUCET_TRUSTED_PROXIES: "0.0.0.0/0",
      },
      storeFactory: () => store,
    });
    const res = mockRes();
    let nextCalled = false;
    await mount(mockReq(), res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "faucet_misconfigured");
    assert.equal(store.rows.length, 0);
  });

  it("fails closed on an invalid budget configuration", async () => {
    const store = new MemoryFaucetStore();
    const mount = createNexoraFaucetMount({
      env: {
        OPENCODE_BASE_URL: "http://127.0.0.1:4096",
        NEXORA_FAUCET_HOME: "/tmp/test-home",
        NEXORA_FAUCET_DAILY_CAP_WEI: "not-a-number",
      },
      storeFactory: () => store,
    });
    const res = mockRes();
    await mount(mockReq(), res, () => {});
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "faucet_misconfigured");
    assert.equal(store.rows.length, 0);
  });
});
