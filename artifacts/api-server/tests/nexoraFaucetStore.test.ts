/**
 * Real-PostgreSQL integration tests for the durable faucet ledger.
 *
 * These tests use a uniquely named temporary table so they can never touch the
 * production `faucet_payouts` rows. They are intentionally skipped when
 * DATABASE_URL is absent; the unit suite covers the handler logic without a
 * database.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createPostgresFaucetStore } from "../src/nexoraFaucetStore.ts";
import type { FaucetReserveInput } from "../src/nexoraFaucetStore.ts";

const requireFromDb = createRequire(
  new URL("../../../lib/db/package.json", import.meta.url),
);
const pg = requireFromDb("pg") as {
  Pool: new (options: { connectionString: string }) => {
    query(text: string, values?: readonly unknown[]): Promise<{
      rows: Array<Record<string, unknown>>;
      rowCount: number | null;
    }>;
    end(): Promise<void>;
  };
};

const ANEX = 10n ** 18n;
const hasDatabase = Boolean(process.env.DATABASE_URL);
const tableName = `faucet_payouts_it_${process.pid}_${Date.now()}`;

let pool: InstanceType<typeof pg.Pool>;

function input(overrides: Partial<FaucetReserveInput> = {}): FaucetReserveInput {
  return {
    clientKey: "client-a",
    recipient: "0x1234567890abcdef1234567890abcdef12345678",
    amount: 100n * ANEX,
    maxPerRequest: 1000n * ANEX,
    cooldownMs: 60_000,
    recipientDailyCap: 5000n * ANEX,
    dailyCap: 50_000n * ANEX,
    ...overrides,
  };
}

describe(
  "postgres faucet ledger",
  { skip: hasDatabase ? false : "DATABASE_URL is not set" },
  () => {
    before(async () => {
      pool = new pg.Pool({ connectionString: process.env.DATABASE_URL! });
      await pool.query(`
        CREATE TABLE "${tableName}" (
          id bigserial PRIMARY KEY,
          client_key text NOT NULL,
          recipient text NOT NULL,
          amount numeric(78, 0) NOT NULL,
          status text NOT NULL DEFAULT 'pending',
          tx_hash text,
          created_at timestamp with time zone NOT NULL DEFAULT now(),
          updated_at timestamp with time zone NOT NULL DEFAULT now()
        )
      `);
    });

    after(async () => {
      if (pool) {
        await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
        await pool.end();
      }
    });

    beforeEach(async () => {
      await pool.query(`TRUNCATE "${tableName}" RESTART IDENTITY`);
    });

    it("serialises concurrent reservations so the daily cap cannot be exceeded", async () => {
      const store = await createPostgresFaucetStore({ pool, tableName });
      const attempts = Array.from({ length: 6 }, (_, index) =>
        store.reserve(
          input({
            clientKey: `daily-client-${index}`,
            recipient: `0x${String(index + 1).padStart(40, "0")}`,
            cooldownMs: 0,
            dailyCap: 150n * ANEX,
          }),
        ),
      );

      const results = await Promise.all(attempts);
      assert.equal(results.filter((result) => result.ok).length, 1);
      assert.equal(
        results.filter(
          (result) => !result.ok && result.reason === "daily_limit",
        ).length,
        5,
      );

      const total = await pool.query(
        `SELECT COALESCE(SUM(amount), 0)::text AS total FROM "${tableName}"`,
      );
      assert.equal(total.rows[0]?.["total"], "100000000000000000000");
    });

    it("serialises concurrent reservations so the recipient cap cannot be exceeded", async () => {
      const store = await createPostgresFaucetStore({ pool, tableName });
      const attempts = Array.from({ length: 6 }, (_, index) =>
        store.reserve(
          input({
            clientKey: `recipient-client-${index}`,
            recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            cooldownMs: 0,
            recipientDailyCap: 150n * ANEX,
            dailyCap: 50_000n * ANEX,
          }),
        ),
      );

      const results = await Promise.all(attempts);
      assert.equal(results.filter((result) => result.ok).length, 1);
      assert.equal(
        results.filter(
          (result) => !result.ok && result.reason === "recipient_daily_limit",
        ).length,
        5,
      );
    });

    it("persists cooldown, recipient spend and daily spend across store instances", async () => {
      const first = await createPostgresFaucetStore({ pool, tableName });
      const reservation = await first.reserve(input());
      assert.equal(reservation.ok, true);
      if (!reservation.ok) return;
      await first.finalize(reservation.id, { status: "sent", txHash: "TX1" });

      // A fresh store instance models a process restart: the ledger, not module
      // memory, must remember the cooldown and the spend.
      const second = await createPostgresFaucetStore({ pool, tableName });

      const sameClient = await second.reserve(
        input({ clientKey: "client-a", cooldownMs: 60_000 }),
      );
      assert.deepEqual(
        { ok: sameClient.ok, reason: sameClient.ok ? null : sameClient.reason },
        { ok: false, reason: "client_cooldown" },
      );

      const sameRecipient = await second.reserve(
        input({
          clientKey: "client-b",
          cooldownMs: 0,
          recipientDailyCap: 150n * ANEX,
          dailyCap: 50_000n * ANEX,
        }),
      );
      assert.deepEqual(
        {
          ok: sameRecipient.ok,
          reason: sameRecipient.ok ? null : sameRecipient.reason,
        },
        { ok: false, reason: "recipient_daily_limit" },
      );

      const otherRecipient = await second.reserve(
        input({
          clientKey: "client-c",
          recipient: "0x9999999999999999999999999999999999999999",
          cooldownMs: 0,
          recipientDailyCap: 5000n * ANEX,
          dailyCap: 150n * ANEX,
        }),
      );
      assert.deepEqual(
        {
          ok: otherRecipient.ok,
          reason: otherRecipient.ok ? null : otherRecipient.reason,
        },
        { ok: false, reason: "daily_limit" },
      );
    });

    it("fails closed when the database pool cannot provide a connection", async () => {
      const failingPool = {
        connect: async () => {
          throw new Error("connection refused");
        },
      };
      const store = await createPostgresFaucetStore({
        pool: failingPool,
        tableName,
      });
      const result = await store.reserve(input());
      assert.deepEqual(result, { ok: false, reason: "store_unavailable" });
    });

    it("rolls back a reservation when the insert cannot complete", async () => {
      const store = await createPostgresFaucetStore({ pool, tableName });
      await pool.query(`DROP TABLE "${tableName}"`);
      try {
        const result = await store.reserve(input({ cooldownMs: 0 }));
        assert.deepEqual(result, { ok: false, reason: "store_unavailable" });
      } finally {
        // Recreate the table for the remaining tests and the after hook.
        await pool.query(`
          CREATE TABLE "${tableName}" (
            id bigserial PRIMARY KEY,
            client_key text NOT NULL,
            recipient text NOT NULL,
            amount numeric(78, 0) NOT NULL,
            status text NOT NULL DEFAULT 'pending',
            tx_hash text,
            created_at timestamp with time zone NOT NULL DEFAULT now(),
            updated_at timestamp with time zone NOT NULL DEFAULT now()
          )
        `);
      }
    });
  },
);
