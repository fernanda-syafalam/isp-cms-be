import { sql } from 'drizzle-orm';
import { index, pgEnum, pgSequence, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { customers } from './customers.schema';
import { tickets } from './tickets.schema';

export const workOrderType = pgEnum('work_order_type', ['install', 'repair', 'dismantle']);
export const workOrderStatus = pgEnum('work_order_status', [
  'scheduled',
  'in_progress',
  'done',
  'cancelled',
]);

// WO-9001, WO-9002, ... from a sequence so codes never collide.
export const workOrderCodeSeq = pgSequence('work_order_code_seq', {
  startWith: 9001,
});

export const workOrders = pgTable(
  'work_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 32 })
      .notNull()
      .unique()
      .default(sql`'WO-' || nextval('work_order_code_seq')`),
    type: workOrderType('type').notNull(),
    // Nullable: a dispatch may precede subscriber creation. customerName
    // is always the displayed label.
    customerId: uuid('customer_id').references(() => customers.id),
    customerName: varchar('customer_name', { length: 120 }).notNull(),
    // Free-text technician name, not an FK (matches the FE contract).
    technician: varchar('technician', { length: 120 }),
    scheduledAt: timestamp('scheduled_at', {
      withTimezone: true,
      precision: 3,
    }).notNull(),
    status: workOrderStatus('status').notNull().default('scheduled'),
    // Nullable: only a repair WO dispatched from a ticket carries this link
    // (P3.B.4). Completing such a WO auto-resolves the linked ticket.
    ticketId: uuid('ticket_id').references(() => tickets.id),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('work_orders_status_idx').on(t.status),
    index('work_orders_customer_id_idx').on(t.customerId),
    index('work_orders_ticket_id_idx').on(t.ticketId),
  ],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type WorkOrder = typeof workOrders.$inferSelect;
export type NewWorkOrder = typeof workOrders.$inferInsert;
