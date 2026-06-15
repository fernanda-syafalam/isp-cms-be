import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  pgEnum,
  pgSequence,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { customers } from './customers.schema';

// PKS (service agreement) lifecycle: draft -> sent -> signed.
export const contractStatus = pgEnum('contract_status', ['draft', 'sent', 'signed']);

// PKS-2026-0001, PKS-2026-0002, ... (year prefix + zero-padded sequence).
export const contractNoSeq = pgSequence('contract_no_seq', { startWith: 1 });

export const contracts = pgTable(
  'contracts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: varchar('number', { length: 32 })
      .notNull()
      .unique()
      .default(
        sql`'PKS-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('contract_no_seq')::text, 4, '0')`,
      ),
    // One contract per subscriber.
    customerId: uuid('customer_id')
      .notNull()
      .unique()
      .references(() => customers.id),
    // Snapshots at creation time (a later rename/plan-change keeps the PKS).
    customerName: varchar('customer_name', { length: 120 }).notNull(),
    planName: varchar('plan_name', { length: 80 }).notNull(),
    status: contractStatus('status').notNull().default('draft'),
    // e-Meterai (Indonesian digital tax stamp) applied — true only once signed.
    meterai: boolean('meterai').notNull().default(false),
    signedAt: timestamp('signed_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('contracts_status_idx').on(t.status)],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type Contract = typeof contracts.$inferSelect;
export type NewContract = typeof contracts.$inferInsert;
