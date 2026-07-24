import { boolean, decimal, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// Application settings — a singleton. The `singleton` flag carries a UNIQUE
// constraint so the table can hold at most one row (the seed insert uses
// onConflictDoNothing against it).
export const appSettings = pgTable('app_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  singleton: boolean('singleton').notNull().default(true).unique(),

  // company
  companyName: varchar('company_name', { length: 120 }).notNull(),
  companyAddress: varchar('company_address', { length: 255 }).notNull(),
  companyPhone: varchar('company_phone', { length: 40 }).notNull(),
  companyEmail: varchar('company_email', { length: 120 }).notNull(),

  // billing
  billingLateFeeIdr: integer('billing_late_fee_idr').notNull(),
  billingDueDays: integer('billing_due_days').notNull(),
  billingIsolirGraceDays: integer('billing_isolir_grace_days').notNull(),

  // tax (PKP / PPN)
  taxPkp: boolean('tax_pkp').notNull(),
  taxNpwp: varchar('tax_npwp', { length: 40 }).notNull(),
  // DB-4: was `real` (float4, ~7 significant digits) — a money-adjacent
  // rate multiplied straight into `ppnOf()` every billing run risked
  // off-by-one-rupiah error at boundary rounding. `numeric(6, 5)` stores
  // the fraction exactly (base-10, no binary-float truncation); the
  // `mode: 'number'` column option maps it back to a plain JS `number` at
  // the drizzle boundary (mapFromDriverValue: Number(value)), so every call
  // site downstream (ppnOf, getBillingPolicy, ...) keeps the exact same
  // `number` type it had with `real` — no read-site cast needed.
  taxPpnRate: decimal('tax_ppn_rate', { precision: 6, scale: 5, mode: 'number' }).notNull(),

  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
});

// Domain types derived from the schema — never hand-written (Pilar 3).
export type AppSettings = typeof appSettings.$inferSelect;
export type NewAppSettings = typeof appSettings.$inferInsert;
