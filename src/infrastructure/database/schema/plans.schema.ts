import { index, integer, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const planStatus = pgEnum('plan_status', ['active', 'archived']);

// Service plan / paket layanan. "Archive" is a status transition, not a
// row delete — invoices and customers reference a plan historically, so
// the row must survive. Listing returns active + archived alike.
export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 80 }).notNull(),
    speedMbps: integer('speed_mbps').notNull(),
    priceMonthly: integer('price_monthly').notNull(), // IDR, whole rupiah
    status: planStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('plans_name_idx').on(t.name)],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
