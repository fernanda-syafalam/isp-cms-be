import { boolean, integer, pgTable, real, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

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
  taxPpnRate: real('tax_ppn_rate').notNull(),

  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
});

// Domain types derived from the schema — never hand-written (Pilar 3).
export type AppSettings = typeof appSettings.$inferSelect;
export type NewAppSettings = typeof appSettings.$inferInsert;
