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
import { vouchers } from './vouchers.schema';

// draft (not issued) -> pending (issued, not due) -> partial (part-paid) ->
// overdue (past due) -> paid. Values are the API enum; the UI maps them to
// Indonesian labels. `partial` counts as unpaid everywhere (aging/dunning).
export const invoiceStatus = pgEnum('invoice_status', [
  'draft',
  'pending',
  'partial',
  'overdue',
  'paid',
]);

// How an offline / loket payment was received.
export const paymentMethod = pgEnum('payment_method', [
  'qris',
  'va',
  'ewallet',
  'transfer',
  'cash',
]);

// What a payment settles: a billed invoice (the default, the vast majority
// of rows) or a loket voucher sale (P3.D.3) that has no invoice at all.
export const paymentSource = pgEnum('payment_source', ['invoice', 'voucher']);

// Invoice number: INV-2026-100, INV-2026-101, ... The year comes from the
// DB clock at insert time; the running number from a sequence so parallel
// billing runs never collide.
export const invoiceNoSeq = pgSequence('invoice_no_seq', { startWith: 100 });

// regular: a normal billing-cycle invoice (`InvoicesService.run` /
// `generateFirstInvoice`), one per customer per period_start — enforced by
// the partial unique index below.
// adjustment: a standalone money-adjustment line backing a plan-change
// proration CHARGE (`CustomersRepository.applyProration`, delta > 0) that
// has no natural billing period of its own — periodStart/periodEnd are the
// day it was raised, not a billing month, so it is deliberately excluded
// from the period-uniqueness invariant (a customer can get more than one
// adjustment invoice on the same day). A proration/SLA CREDIT never creates
// a row of this type — it is applied as a `discountAmount` bump on an
// existing regular invoice instead (see `applyProration` /
// `SlaCreditsRepository.apply`).
export const invoiceType = pgEnum('invoice_type', ['regular', 'adjustment']);

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
    type: invoiceType('type').notNull().default('regular'),
    // Human-readable reason for an 'adjustment' invoice (e.g. "Proration:
    // Home 20 -> Home 50"). Null for every 'regular' invoice.
    note: varchar('note', { length: 200 }),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    // All money is whole IDR. amount = plan price (DPP); lateFee = denda;
    // taxAmount = PPN. Invoice total = amount + lateFee + taxAmount.
    amount: integer('amount').notNull(),
    lateFee: integer('late_fee').notNull().default(0),
    taxAmount: integer('tax_amount').notNull().default(0),
    // SLA-credit deduction line (P3.A.4). Invoice total =
    // amount + lateFee + taxAmount - discountAmount.
    discountAmount: integer('discount_amount').notNull().default(0),
    // Cumulative amount received against this invoice (partial payments).
    // balanceDue = total - paidAmount; status flips to 'paid' when it hits 0.
    paidAmount: integer('paid_amount').notNull().default(0),
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
    index('invoices_type_idx').on(t.type),
    // One REGULAR invoice per customer per billing period — enforces the
    // "no duplicate period" invariant at the DB, so a re-run of billing is
    // naturally idempotent. Partial (`WHERE type = 'regular'`) so a
    // proration 'adjustment' invoice — which shares a periodStart with
    // whatever day it was raised on, not a billing month — never collides
    // with the customer's regular invoice for that period, or with another
    // adjustment invoice raised the same day.
    uniqueIndex('invoices_customer_period_idx')
      .on(t.customerId, t.periodStart)
      .where(sql`${t.type} = 'regular'`),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Nullable (P3.D.3): a voucher sale (source = 'voucher') settles a
    // voucher, not an invoice, and has neither. Still an FK when present —
    // every invoice-sourced payment must point at a real invoice.
    invoiceId: uuid('invoice_id').references(() => invoices.id),
    // Denormalized snapshot so the ledger reads without joins; null alongside
    // invoiceId for voucher-sourced rows.
    invoiceNo: varchar('invoice_no', { length: 32 }),
    // Nullable: an anonymous hotspot voucher redemption (P3.D.3) has no
    // subscriber to snapshot.
    customerId: uuid('customer_id'),
    customerName: varchar('customer_name', { length: 120 }),
    amount: integer('amount').notNull(),
    method: paymentMethod('method').notNull(),
    // What this payment settles — an invoice (default) or a voucher sale
    // (P3.D.3). Drives which of invoiceId/voucherId is populated.
    source: paymentSource('source').notNull().default('invoice'),
    // Set only for source = 'voucher' — the voucher this payment sold/redeemed.
    voucherId: uuid('voucher_id').references(() => vouchers.id),
    // Loket cash drawer (P3.A.4): cash tendered by the customer and the change
    // given back. Null for non-cash rails. changeAmount = tendered - amount.
    tenderedAmount: integer('tendered_amount'),
    changeAmount: integer('change_amount'),
    paidAt: timestamp('paid_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('payments_invoice_id_idx').on(t.invoiceId),
    index('payments_customer_id_idx').on(t.customerId),
    index('payments_voucher_id_idx').on(t.voucherId),
  ],
);

// Online gateway rails (QRIS / Virtual Account / e-wallet). Mirror what
// Midtrans/Xendit expose; mock-first but contract-ready.
export const paymentChannel = pgEnum('payment_channel', [
  'qris',
  'va_bca',
  'va_mandiri',
  'va_bri',
  'va_bni',
  'gopay',
  'ovo',
  'dana',
  'shopeepay',
]);

export const paymentIntentStatus = pgEnum('payment_intent_status', ['pending', 'paid', 'expired']);

// A pending gateway charge for an invoice. A real gateway returns a VA number
// or QR payload and fires a settlement webhook; here `confirm` simulates that
// webhook and reuses the invoice settlement path (mark paid + ledger entry).
export const paymentIntents = pgTable(
  'payment_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    // Denormalized snapshots so the intent renders without joins.
    invoiceNo: varchar('invoice_no', { length: 32 }).notNull(),
    customerName: varchar('customer_name', { length: 120 }).notNull(),
    amount: integer('amount').notNull(),
    channel: paymentChannel('channel').notNull(),
    status: paymentIntentStatus('status').notNull().default('pending'),
    // Exactly one of these is set per channel: VA rails get a number, QR /
    // e-wallet rails get a payload. In `PAYMENT_MODE=live` (Tripay),
    // `qrPayload` also carries the e-wallet `checkoutUrl` — the field was
    // already a generic "channel payload" string, so no separate column
    // is needed for that case.
    vaNumber: varchar('va_number', { length: 40 }),
    qrPayload: varchar('qr_payload', { length: 512 }),
    // Gateway's own transaction id (Tripay `reference`), null in
    // `PAYMENT_MODE=simulation`. Populated at charge-create time; the
    // webhook cross-checks it against the callback's `reference` as a
    // defense-in-depth integrity check (the primary lookup key is still
    // `payment_intents.id`, sent to the gateway as `merchant_ref`). Purely
    // for reconciliation/audit — nothing reads it for correctness.
    gatewayReference: varchar('gateway_reference', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_intents_invoice_id_idx').on(t.invoiceId),
    index('payment_intents_gateway_reference_idx').on(t.gatewayReference),
  ],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type PaymentIntent = typeof paymentIntents.$inferSelect;
export type NewPaymentIntent = typeof paymentIntents.$inferInsert;
