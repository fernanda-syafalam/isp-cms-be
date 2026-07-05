import { index, integer, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { customers } from './customers.schema';
import { invoices } from './invoices.schema';
import { tickets } from './tickets.schema';

// pending -> applied (deducted from the next invoice) | void (cancelled).
export const slaCreditStatus = pgEnum('sla_credit_status', ['pending', 'applied', 'void']);

export const slaCredits = pgTable(
  'sla_credits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Nullable FKs — a credit may be issued against a name/ticket-code that
    // does not resolve. The *Name / *Code fields are the displayed labels.
    customerId: uuid('customer_id').references(() => customers.id),
    customerName: varchar('customer_name', { length: 120 }).notNull(),
    amount: integer('amount').notNull(), // whole IDR
    reason: varchar('reason', { length: 200 }).notNull(),
    ticketId: uuid('ticket_id').references(() => tickets.id),
    ticketCode: varchar('ticket_code', { length: 40 }),
    status: slaCreditStatus('status').notNull().default('pending'),
    // The invoice that absorbed this credit as a discount line (P3.A.4).
    // Null until applied; set together with status='applied'.
    appliedInvoiceId: uuid('applied_invoice_id').references(() => invoices.id),
    appliedAt: timestamp('applied_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('sla_credits_status_idx').on(t.status),
    index('sla_credits_customer_id_idx').on(t.customerId),
    index('sla_credits_created_at_idx').on(t.createdAt),
  ],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type SlaCredit = typeof slaCredits.$inferSelect;
export type NewSlaCredit = typeof slaCredits.$inferInsert;
