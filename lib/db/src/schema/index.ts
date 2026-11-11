import {
  bigserial,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Durable faucet ledger.
 *
 * A row is inserted before any tokens are sent ("pending"). The row is updated
 * to "sent" or "failed" afterwards. Budget checks count every row for the
 * current UTC day, including failed attempts, so an ambiguous evmd failure can
 * never release budget that may already have been spent.
 *
 * `client_key` is a SHA-256 digest of the resolved client address, not the raw
 * address. It is only used for equality comparisons in the cooldown query.
 */
export const faucetPayouts = pgTable(
  "faucet_payouts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    clientKey: text("client_key").notNull(),
    recipient: text("recipient").notNull(),
    amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
    status: text("status").notNull().default("pending"),
    txHash: text("tx_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("faucet_payouts_client_created_idx").on(
      table.clientKey,
      table.createdAt,
    ),
    index("faucet_payouts_recipient_created_idx").on(
      table.recipient,
      table.createdAt,
    ),
    index("faucet_payouts_created_idx").on(table.createdAt),
  ],
);

export type FaucetPayout = typeof faucetPayouts.$inferSelect;
export type NewFaucetPayout = typeof faucetPayouts.$inferInsert;
