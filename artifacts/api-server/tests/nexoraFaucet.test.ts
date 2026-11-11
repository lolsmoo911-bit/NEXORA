import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleFaucet } from "../src/nexoraFaucet.ts";
import {
  createNexoraFaucetMount,
  nexoraFaucet,
} from "../src/nexoraFaucetMount.ts";
import { MemoryFaucetStore } from "./helpers/faucetStore.ts";

// Mock Express Request/Response
function mockReq(overrides: Record<string, any> = {}) {
  return {
    method: "POST",
    headers: {},
    body: {},
    socket: { remoteAddress: "127.0.0.1" },
    url: "/api/nexora/faucet",
    ...overrides,
  } as any;
}

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) { res.statusCode = code; return res; },
    json(data: any) { res.body = data; return res; },
  };
  return res;
}

const VALID_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const TESTNET_CFG = {
  opencode: { baseUrl: "http://127.0.0.1:4096" },
  faucetHome: "/tmp/test-home",
  faucetAccount: "dev3",
  faucetNode: "http://127.0.0.1:26657",
  faucetChainId: "eip155:902024",
  evmdPath: "evmd",
  store: new MemoryFaucetStore(),
};

beforeEach(() => {
  TESTNET_CFG.store = new MemoryFaucetStore();
});

const successRunner = async () => ({
  stdout: JSON.stringify({ txhash: "ABCDEF1234567890" }),
  stderr: "",
});

const failRunner = async () => {
  const err = new Error("evmd failed") as any;
  err.stderr = "error: insufficient funds 0x" + "a".repeat(64);
  throw err;
};

const throwingRunner = async () => {
  throw new TypeError("unexpected error");
};

describe("handleFaucet", () => {
  let ipCounter = 0;
  function uniqueReq(overrides: Record<string, any> = {}) {
    ipCounter++;
    return mockReq({
      socket: { remoteAddress: `10.0.0.${ipCounter}` },
      ...overrides,
    });
  }

  it("1. success: returns txhash and amount", async () => {
    const req = uniqueReq({ body: { address: VALID_ADDR } });
    const res = mockRes();
    await handleFaucet(req, res, { ...TESTNET_CFG, runner: successRunner });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.txhash, "ABCDEF1234567890");
  });

  it("2. invalid address: returns 400 bad_address", async () => {
    const req = uniqueReq({ body: { address: "0xinvalid" } });
    const res = mockRes();
    await handleFaucet(req, res, { ...TESTNET_CFG, runner: successRunner });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "bad_address");
  });

  it("3. zero address: returns 400 bad_address", async () => {
    const req = uniqueReq({ body: { address: "0x" + "0".repeat(40) } });
    const res = mockRes();
    await handleFaucet(req, res, { ...TESTNET_CFG, runner: successRunner });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "bad_address");
  });

  it("4. invalid amount (non-numeric): returns 400 bad_amount", async () => {
    const req = uniqueReq({ body: { address: VALID_ADDR, amount: "abc" } });
    const res = mockRes();
    await handleFaucet(req, res, { ...TESTNET_CFG, runner: successRunner });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "bad_amount");
  });

  it("5. invalid amount (negative): returns 400 bad_amount", async () => {
    const req = uniqueReq({ body: { address: VALID_ADDR, amount: "-5" } });
    const res = mockRes();
    await handleFaucet(req, res, { ...TESTNET_CFG, runner: successRunner });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "bad_amount");
  });

  it("6. wrong chain ID: returns 403 faucet_wrong_chain", async () => {
    const req = uniqueReq({ body: { address: VALID_ADDR } });
    const res = mockRes();
    await handleFaucet(req, res, { ...TESTNET_CFG, faucetChainId: "eip155:1", runner: successRunner });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "faucet_wrong_chain");
  });

  it("7. non-loopback URL: returns 403 faucet_refuses_non_loopback", async () => {
    const req = uniqueReq({ body: { address: VALID_ADDR } });
    const res = mockRes();
    await handleFaucet(req, res, { ...TESTNET_CFG, opencode: { baseUrl: "https://evil.com" }, runner: successRunner });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "faucet_refuses_non_loopback");
  });

  it("8. not configured (no home): returns 503 faucet_not_configured", async () => {
    const req = uniqueReq({ body: { address: VALID_ADDR } });
    const res = mockRes();
    await handleFaucet(req, res, { ...TESTNET_CFG, faucetHome: undefined, runner: successRunner });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "faucet_not_configured");
  });

  it("9. evmd failure: returns 502 faucet_send_failed with redacted detail", async () => {
    const req = uniqueReq({ body: { address: VALID_ADDR } });
    const res = mockRes();
    await handleFaucet(req, res, { ...TESTNET_CFG, runner: failRunner });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error, "faucet_send_failed");
    assert.ok(!res.body.detail.includes("a".repeat(64)), "detail should not contain unredacted hex");
    assert.ok(res.body.detail.includes("[redacted]"), "detail should contain [redacted]");
  });

  it("10. rate limiting: second request within cooldown returns 429", async () => {
    const ip = `10.0.0.${++ipCounter}`;
    const req1 = mockReq({ socket: { remoteAddress: ip }, body: { address: VALID_ADDR } });
    const res1 = mockRes();
    await handleFaucet(req1, res1, { ...TESTNET_CFG, runner: successRunner });
    assert.equal(res1.statusCode, 200);

    const req2 = mockReq({ socket: { remoteAddress: ip }, body: { address: VALID_ADDR } });
    const res2 = mockRes();
    await handleFaucet(req2, res2, { ...TESTNET_CFG, runner: successRunner });
    assert.equal(res2.statusCode, 429);
    assert.equal(res2.body.error, "rate_limited");
    assert.ok(res2.body.retryAfterSeconds > 0);
  });

  it("11. POST only: GET returns 405 post_only", async () => {
    const req = uniqueReq({ method: "GET", body: { address: VALID_ADDR } });
    const res = mockRes();
    await handleFaucet(req, res, { ...TESTNET_CFG, runner: successRunner });
    assert.equal(res.statusCode, 405);
    assert.equal(res.body.error, "post_only");
  });

  it("12. default amount: uses DEFAULT_PAYOUT when no amount given", async () => {
    const req = uniqueReq({ body: { address: VALID_ADDR } });
    const res = mockRes();
    await handleFaucet(req, res, { ...TESTNET_CFG, runner: successRunner });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.amountAnex, 100);
  });

  it("13. amount capping: caps at MAX_PER_REQUEST", async () => {
    const req = uniqueReq({ body: { address: VALID_ADDR, amount: "999999999999999999999999" } });
    const res = mockRes();
    await handleFaucet(req, res, { ...TESTNET_CFG, runner: successRunner });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.amountAnex, 1000);
  });

  it("14. secret redaction: hex keys stripped from error detail", async () => {
    const secretRunner = async () => {
      const err = new Error("failed") as any;
      err.stderr = "key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      throw err;
    };
    const req = uniqueReq({ body: { address: VALID_ADDR } });
    const res = mockRes();
    await handleFaucet(req, res, { ...TESTNET_CFG, runner: secretRunner });
    assert.equal(res.statusCode, 502);
    assert.ok(!res.body.detail.includes("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"), "secret should be redacted");
    assert.ok(res.body.detail.includes("[redacted]"), "should contain [redacted]");
  });

  it("15. unexpected rejection from runner is caught and returns 502", async () => {
    const req = uniqueReq({ body: { address: VALID_ADDR } });
    const res = mockRes();
    await handleFaucet(req, res, { ...TESTNET_CFG, runner: throwingRunner });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error, "faucet_send_failed");
  });
});

describe("nexoraFaucet (mount)", () => {
  it("16. calls next() for non-faucet URLs", () => {
    const req = mockReq({ url: "/api/other" });
    const res = mockRes();
    let nextCalled = false;
    let nextError: any = null;
    const next = (e?: any) => { nextCalled = true; nextError = e; };
    nexoraFaucet(req, res, next);
    assert.ok(nextCalled, "next() should be called for non-faucet URLs");
    assert.equal(nextError, undefined, "next() should be called without error");
  });

  it("16b. does not treat a lookalike path as the faucet", async () => {
    const req = mockReq({ url: "/api/nexora/faucet-evil" });
    const res = mockRes();
    let nextCalled = false;
    await nexoraFaucet(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(res.body, null);
  });

  it("17. mount returns 503 when the faucet home is not configured", async () => {
    const mount = createNexoraFaucetMount({
      env: {
        OPENCODE_BASE_URL: "http://127.0.0.1:4096",
        NEXORA_FAUCET_HOME: "",
        NEXORA_FAUCET_CHAIN_ID: "eip155:902024",
      },
      storeFactory: () => new MemoryFaucetStore(),
    });
    const req = mockReq({ url: "/api/nexora/faucet", body: { address: VALID_ADDR } });
    const res = mockRes();
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };

    await mount(req, res, next);

    assert.equal(nextCalled, false, "mount should not pass a handled request to next()");
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "faucet_not_configured");
  });
});
