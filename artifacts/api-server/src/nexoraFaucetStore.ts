/**
 * Durable faucet ledger.
 *
 * All budget checks and the reservation insert run in one PostgreSQL
 * transaction. A transaction-scoped advisory lock serialises every reservation,
 * so two concurrent requests (in this process or in another server instance)
 * cannot both observe the same remaining daily budget.
 *
 * The row is inserted as "pending" BEFORE evmd is executed. The daily and
 * per-recipient sums deliberately include pending, sent and failed rows. A
 * failed evmd invocation is therefore still charged against the budget, which
 * is the conservative choice when a timeout could mean the transaction was
 * already broadcast.
 */

export interface FaucetReserveInput {
  /** SHA-256 digest of the resolved client address, never the raw address. */
  clientKey: string;
  recipient: string;
  amount: bigint;
  maxPerRequest: bigint;
  cooldownMs: number;
  recipientDailyCap: bigint;
  dailyCap: bigint;
}

export type FaucetReserveResult =
  | { ok: true; id: number }
  | { ok: false; reason: "invalid_amount" | "store_unavailable" }
  | {
      ok: false;
      reason: "client_cooldown" | "recipient_daily_limit" | "daily_limit";
      retryAfterSeconds: number;
    };

export interface FaucetFinalizeOutcome {
  status: "sent" | "failed";
  txHash?: string;
}

export interface FaucetStore {
  reserve(input: FaucetReserveInput): Promise<FaucetReserveResult>;
  finalize(id: number, outcome: FaucetFinalizeOutcome): Promise<void>;
}

interface FaucetQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

interface FaucetPoolClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<FaucetQueryResult>;
  release(): void;
}

/** Minimal structural type so tests can inject a fake pool. */
export interface FaucetPool {
  connect(): Promise<FaucetPoolClient>;
}

export interface PostgresFaucetStoreOptions {
  pool?: FaucetPool;
  /** Test-only override; production always uses the canonical table. */
  tableName?: string;
}

const DEFAULT_TABLE = "faucet_payouts";
const UTC_DAY_START =
  "date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'";

function safeTableName(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error("invalid faucet ledger table name");
  }
  return `"${name}"`;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function asBigInt(value: unknown): bigint {
  if (value === null || value === undefined) return 0n;
  return BigInt(String(value));
}

function asId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function secondsUntilUtcMidnight(from: Date): number {
  const next = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((next - from.getTime()) / 1000));
}

/**
 * Build the production store. The database module is imported lazily so unit
 * tests that inject a fake store never need DATABASE_URL or a live database.
 */
export async function createPostgresFaucetStore(
  options: PostgresFaucetStoreOptions = {},
): Promise<FaucetStore> {
  const pool =
    options.pool ??
    ((await import("@workspace/db")).pool as unknown as FaucetPool);
  const table = safeTableName(options.tableName ?? DEFAULT_TABLE);

  return {
    async reserve(input: FaucetReserveInput): Promise<FaucetReserveResult> {
      if (input.amount <= 0n || input.amount > input.maxPerRequest) {
        return { ok: false, reason: "invalid_amount" };
      }

      let client: FaucetPoolClient;
      try {
        client = await pool.connect();
      } catch {
        return { ok: false, reason: "store_unavailable" };
      }

      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('nexora_faucet_budget')::bigint)",
        );

        const clock = await client.query("SELECT now() AS db_now");
        const dbNow = asDate(clock.rows[0]?.["db_now"]);
        if (!dbNow) throw new Error("database clock unavailable");

        const last = await client.query(
          `SELECT created_at FROM ${table}
             WHERE client_key = $1
             ORDER BY created_at DESC
             LIMIT 1`,
          [input.clientKey],
        );
        const lastAt = asDate(last.rows[0]?.["created_at"]);
        if (lastAt) {
          const elapsedMs = dbNow.getTime() - lastAt.getTime();
          if (elapsedMs < input.cooldownMs) {
            await client.query("ROLLBACK");
            return {
              ok: false,
              reason: "client_cooldown",
              retryAfterSeconds: Math.max(
                1,
                Math.ceil((input.cooldownMs - elapsedMs) / 1000),
              ),
            };
          }
        }

        const recipient = await client.query(
          `SELECT COALESCE(SUM(amount), 0)::text AS total
             FROM ${table}
             WHERE recipient = $1
               AND created_at >= ${UTC_DAY_START}`,
          [input.recipient],
        );
        const recipientTotal = asBigInt(recipient.rows[0]?.["total"]);
        if (recipientTotal + input.amount > input.recipientDailyCap) {
          await client.query("ROLLBACK");
          return {
            ok: false,
            reason: "recipient_daily_limit",
            retryAfterSeconds: secondsUntilUtcMidnight(dbNow),
          };
        }

        const daily = await client.query(
          `SELECT COALESCE(SUM(amount), 0)::text AS total
             FROM ${table}
             WHERE created_at >= ${UTC_DAY_START}`,
        );
        const dailyTotal = asBigInt(daily.rows[0]?.["total"]);
        if (dailyTotal + input.amount > input.dailyCap) {
          await client.query("ROLLBACK");
          return {
            ok: false,
            reason: "daily_limit",
            retryAfterSeconds: secondsUntilUtcMidnight(dbNow),
          };
        }

        const inserted = await client.query(
          `INSERT INTO ${table} (client_key, recipient, amount, status)
             VALUES ($1, $2, $3::numeric, 'pending')
             RETURNING id`,
          [input.clientKey, input.recipient, input.amount.toString()],
        );
        const id = asId(inserted.rows[0]?.["id"]);
        if (!id) throw new Error("reservation id unavailable");

        await client.query("COMMIT");
        return { ok: true, id };
      } catch {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* the connection may already be unusable */
        }
        return { ok: false, reason: "store_unavailable" };
      } finally {
        client.release();
      }
    },

    async finalize(id: number, outcome: FaucetFinalizeOutcome): Promise<void> {
      const client = await pool.connect();
      try {
        const updated = await client.query(
          `UPDATE ${table}
             SET status = $2, tx_hash = $3, updated_at = now()
             WHERE id = $1`,
          [id, outcome.status, outcome.txHash ?? null],
        );
        if (updated.rowCount === 0) {
          throw new Error("faucet reservation not found");
        }
      } finally {
        client.release();
      }
    },
  };
}
