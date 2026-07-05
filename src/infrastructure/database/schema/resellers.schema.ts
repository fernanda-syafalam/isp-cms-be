import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  real,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const resellerStatus = pgEnum('reseller_status', ['active', 'inactive']);
// Credits (topup/commission) raise the balance; debits (deduction/
// withdrawal) lower it.
export const resellerLedgerType = pgEnum('reseller_ledger_type', [
  'topup',
  'commission',
  'deduction',
  'withdrawal',
]);

export const resellers = pgTable(
  'resellers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 120 }).notNull(),
    area: varchar('area', { length: 120 }).notNull(),
    balance: integer('balance').notNull().default(0), // whole IDR
    // Commission rate as a fraction (e.g. 0.05 = 5%).
    commissionPct: real('commission_pct').notNull().default(0),
    status: resellerStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('resellers_status_idx').on(t.status)],
);

// Append-only balance ledger; amount is signed, balanceAfter is the running
// balance once this entry is applied.
export const resellerLedger = pgTable(
  'reseller_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resellerId: uuid('reseller_id')
      .notNull()
      .references(() => resellers.id),
    type: resellerLedgerType('type').notNull(),
    amount: integer('amount').notNull(),
    note: varchar('note', { length: 200 }).notNull().default(''),
    balanceAfter: integer('balance_after').notNull(),
    // Idempotency source for auto-posted entries (P3.D.1): the invoice id a
    // commission was earned on. Unique per (reseller, type, ref) so replaying
    // a payment never double-credits. Null for manual topup/withdrawal.
    ref: varchar('ref', { length: 64 }),
    at: timestamp('at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('reseller_ledger_reseller_id_idx').on(t.resellerId),
    index('reseller_ledger_at_idx').on(t.at),
    uniqueIndex('reseller_ledger_reseller_type_ref_idx')
      .on(t.resellerId, t.type, t.ref)
      .where(sql`${t.ref} is not null`),
  ],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type Reseller = typeof resellers.$inferSelect;
export type NewReseller = typeof resellers.$inferInsert;
export type ResellerLedgerEntry = typeof resellerLedger.$inferSelect;
export type NewResellerLedgerEntry = typeof resellerLedger.$inferInsert;
