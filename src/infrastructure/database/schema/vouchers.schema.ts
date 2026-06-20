import { index, integer, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// unused -> used (redeemed); expired when past its validity window.
export const voucherStatus = pgEnum('voucher_status', ['unused', 'used', 'expired']);

export const vouchers = pgTable(
  'vouchers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // ASH-XXXX-XXXX, unique across all time.
    code: varchar('code', { length: 32 }).notNull().unique(),
    // Groups vouchers minted together (BATCH-XXXXXXXX).
    batchId: varchar('batch_id', { length: 32 }).notNull(),
    // Hotspot / PPPoE profile name (free text — not an FK).
    profile: varchar('profile', { length: 80 }).notNull(),
    priceIdr: integer('price_idr').notNull(),
    durationDays: integer('duration_days').notNull(),
    status: voucherStatus('status').notNull().default('unused'),
    usedAt: timestamp('used_at', { withTimezone: true, precision: 3 }),
    // Free-text redeemer label (hotspot user, admin, ...).
    usedBy: varchar('used_by', { length: 120 }),
    // Subscriber the voucher was redeemed against (loket sale to a customer);
    // null for anonymous hotspot redemptions. Resolved in the service, so this
    // is a denormalized link rather than a hard FK (matches the other
    // service-resolved customer references).
    redeemedCustomerId: uuid('redeemed_customer_id'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('vouchers_status_idx').on(t.status),
    index('vouchers_batch_id_idx').on(t.batchId),
    index('vouchers_created_at_idx').on(t.createdAt),
  ],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type Voucher = typeof vouchers.$inferSelect;
export type NewVoucher = typeof vouchers.$inferInsert;
