import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const branchStatus = pgEnum('branch_status', ['active', 'inactive']);

// Operational branch / POP. customerCount / mrr / deviceCount are stored
// roll-up figures (no branch<->customer link exists in the data model yet,
// so they are not derived) — placeholders until that link lands.
export const branches = pgTable(
  'branches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 120 }).notNull(),
    city: varchar('city', { length: 80 }).notNull(),
    manager: varchar('manager', { length: 120 }).notNull(),
    phone: varchar('phone', { length: 20 }).notNull(),
    status: branchStatus('status').notNull().default('active'),
    isHeadOffice: boolean('is_head_office').notNull().default(false),
    customerCount: integer('customer_count').notNull().default(0),
    mrr: integer('mrr').notNull().default(0), // monthly recurring revenue, whole IDR
    deviceCount: integer('device_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('branches_status_idx').on(t.status)],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;
