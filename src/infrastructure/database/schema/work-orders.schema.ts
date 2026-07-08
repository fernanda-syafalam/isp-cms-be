import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
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
    // Field-completion evidence captured when a technician finishes an
    // install/repair (P3.B.3). All nullable — a WO completed with no field
    // kit (or before this feature existed) simply carries nulls here, and
    // the deterministic fallback in the service still applies.
    scannedOnuSerial: varchar('scanned_onu_serial', { length: 64 }),
    measuredRxPower: real('measured_rx_power'),
    // Evidence photo URLs/refs — no upload endpoint in scope yet, so this
    // stores whatever string refs the client already has.
    photos: jsonb('photos').$type<string[]>(),
    signatureUrl: varchar('signature_url', { length: 512 }),
    gpsLat: real('gps_lat'),
    gpsLng: real('gps_lng'),
    // Free-text field notes the technician enters on completion (e.g. what
    // was actually done, obstacles encountered). Nullable — same
    // degrade-gracefully contract as the rest of the evidence columns.
    completionNotes: text('completion_notes'),
    completedAt: timestamp('completed_at', { withTimezone: true, precision: 3 }),
    completedBy: varchar('completed_by', { length: 120 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('work_orders_status_idx').on(t.status),
    index('work_orders_customer_id_idx').on(t.customerId),
    index('work_orders_ticket_id_idx').on(t.ticketId),
    // Backs the teknisi "Tugas saya" filter, an exact-match lookup on this
    // free-text column (ARCH-6).
    index('work_orders_technician_idx').on(t.technician),
  ],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type WorkOrder = typeof workOrders.$inferSelect;
export type NewWorkOrder = typeof workOrders.$inferInsert;
