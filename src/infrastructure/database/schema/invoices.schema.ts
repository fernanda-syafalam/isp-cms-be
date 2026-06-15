import { sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  pgEnum,
  pgSequence,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { customers } from './customers.schema';

// draft (not issued) -> pending (issued, not due) -> overdue (past due) ->
// paid. Values are the API enum; the UI maps them to Indonesian labels.
export const invoiceStatus = pgEnum('invoice_status', ['draft', 'pending', 'overdue', 'paid']);

// How an offline / loket payment was received.
export const paymentMethod = pgEnum('payment_method', [
  'qris',
  'va',
  'ewallet',
  'transfer',
  'cash',
]);

// Invoice number: INV-2026-100, INV-2026-101, ... The year comes from the
// DB clock at insert time; the running number from a sequence so parallel
// billing runs never collide.
export const invoiceNoSeq = pgSequence('invoice_no_seq', { startWith: 100 });

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceNo: varchar('invoice_no', { length: 32 })
      .notNull()
      .unique()
      .default(sql`'INV-' || to_char(now(), 'YYYY') || '-' || nextval('invoice_no_seq')`),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    // Snapshot of the customer name at issue time (denormalized on purpose
    // — a later rename must not rewrite history).
    customerName: varchar('customer_name', { length: 120 }).notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    // All money is whole IDR. amount = plan price (DPP); lateFee = denda;
    // taxAmount = PPN. Invoice total = amount + lateFee + taxAmount.
    amount: integer('amount').notNull(),
    lateFee: integer('late_fee').notNull().default(0),
    taxAmount: integer('tax_amount').notNull().default(0),
    // E-Faktur / Coretax number; null for drafts and non-PKP issuers.
    taxInvoiceNo: varchar('tax_invoice_no', { length: 40 }),
    status: invoiceStatus('status').notNull().default('pending'),
    dueDate: date('due_date').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true, precision: 3 }),
    lastRemindedAt: timestamp('last_reminded_at', {
      withTimezone: true,
      precision: 3,
    }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('invoices_customer_id_idx').on(t.customerId),
    index('invoices_status_idx').on(t.status),
    // One invoice per customer per billing period — enforces the
    // "no duplicate period" invariant at the DB, so a re-run of billing
    // is naturally idempotent.
    uniqueIndex('invoices_customer_period_idx').on(t.customerId, t.periodStart),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    // Denormalized snapshots so the ledger reads without joins.
    invoiceNo: varchar('invoice_no', { length: 32 }).notNull(),
    customerId: uuid('customer_id').notNull(),
    customerName: varchar('customer_name', { length: 120 }).notNull(),
    amount: integer('amount').notNull(),
    method: paymentMethod('method').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('payments_invoice_id_idx').on(t.invoiceId),
    index('payments_customer_id_idx').on(t.customerId),
  ],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
