import type {
  FaucetFinalizeOutcome,
  FaucetReserveInput,
  FaucetReserveResult,
  FaucetStore,
} from "../../src/nexoraFaucetStore.ts";

export interface FakeFaucetRow {
  id: number;
  clientKey: string;
  recipient: string;
  amount: bigint;
  status: "pending" | "sent" | "failed";
  txHash?: string;
  createdAt: Date;
}

/**
 * Test-only store with the same reservation semantics as the PostgreSQL store.
 * `exclusive()` models the database advisory lock: concurrent reserve() calls
 * are serialised, so a budget check cannot race an insert.
 *
 * This is deliberately not used by production code.
 */
export class MemoryFaucetStore implements FaucetStore {
  rows: FakeFaucetRow[];
  failNextReserve = false;
  failNextFinalize = false;
  private readonly now: () => Date;
  private tail: Promise<void> = Promise.resolve();
  private nextId: number;

  constructor(options: { rows?: FakeFaucetRow[]; now?: () => Date } = {}) {
    this.rows = options.rows ?? [];
    this.now = options.now ?? (() => new Date());
    this.nextId =
      this.rows.reduce((maximum, row) => Math.max(maximum, row.id), 0) + 1;
  }

  private exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private secondsUntilUtcMidnight(from: Date): number {
    const next = Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate() + 1,
    );
    return Math.max(1, Math.ceil((next - from.getTime()) / 1000));
  }

  async reserve(input: FaucetReserveInput): Promise<FaucetReserveResult> {
    if (this.failNextReserve) {
      this.failNextReserve = false;
      return { ok: false, reason: "store_unavailable" };
    }

    return this.exclusive(() => {
      if (input.amount <= 0n || input.amount > input.maxPerRequest) {
        return { ok: false, reason: "invalid_amount" } as const;
      }

      const now = this.now();
      const previous = [...this.rows]
        .reverse()
        .find((row) => row.clientKey === input.clientKey);
      if (previous) {
        const elapsedMs = now.getTime() - previous.createdAt.getTime();
        if (elapsedMs < input.cooldownMs) {
          return {
            ok: false,
            reason: "client_cooldown",
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((input.cooldownMs - elapsedMs) / 1000),
            ),
          } as const;
        }
      }

      const dayStart = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
      );
      const today = this.rows.filter(
        (row) => row.createdAt.getTime() >= dayStart,
      );

      const recipientTotal = today
        .filter((row) => row.recipient === input.recipient)
        .reduce((total, row) => total + row.amount, 0n);
      if (recipientTotal + input.amount > input.recipientDailyCap) {
        return {
          ok: false,
          reason: "recipient_daily_limit",
          retryAfterSeconds: this.secondsUntilUtcMidnight(now),
        } as const;
      }

      const dailyTotal = today.reduce(
        (total, row) => total + row.amount,
        0n,
      );
      if (dailyTotal + input.amount > input.dailyCap) {
        return {
          ok: false,
          reason: "daily_limit",
          retryAfterSeconds: this.secondsUntilUtcMidnight(now),
        } as const;
      }

      const row: FakeFaucetRow = {
        id: this.nextId++,
        clientKey: input.clientKey,
        recipient: input.recipient,
        amount: input.amount,
        status: "pending",
        createdAt: now,
      };
      this.rows.push(row);
      return { ok: true, id: row.id } as const;
    });
  }

  async finalize(
    id: number,
    outcome: FaucetFinalizeOutcome,
  ): Promise<void> {
    if (this.failNextFinalize) {
      this.failNextFinalize = false;
      throw new Error("store finalize failure");
    }
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error("faucet reservation not found");
    row.status = outcome.status;
    row.txHash = outcome.txHash;
  }
}
