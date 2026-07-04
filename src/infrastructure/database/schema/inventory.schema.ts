import { index, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { customers } from './customers.schema';

export const inventoryKind = pgEnum('inventory_kind', ['onu', 'router', 'mikrotik']);
export const inventoryStatus = pgEnum('inventory_status', ['warehouse', 'installed', 'broken']);
export const stockMovementType = pgEnum('stock_movement_type', [
  'in',
  'assign',
  'return',
  'broken',
]);

export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: inventoryKind('kind').notNull(),
    serial: varchar('serial', { length: 80 }).notNull().unique(),
    status: inventoryStatus('status').notNull().default('warehouse'),
    // assignedTo is the subscriber name; assignedCustomerId is the resolved
    // FK (both null while in the warehouse).
    assignedTo: varchar('assigned_to', { length: 120 }),
    assignedCustomerId: uuid('assigned_customer_id').references(() => customers.id),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('inventory_items_status_idx').on(t.status),
    index('inventory_items_kind_idx').on(t.kind),
  ],
);

// Immutable audit trail of stock state changes.
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => inventoryItems.id),
    // Denormalized snapshots so the ledger reads without joins.
    serial: varchar('serial', { length: 80 }).notNull(),
    kind: inventoryKind('kind').notNull(),
    type: stockMovementType('type').notNull(),
    note: varchar('note', { length: 255 }).notNull(),
    // The work order that drove this movement (an install assign), so stock
    // consumption reconciles with the order. Denormalized like the rest of the
    // ledger — null for manual / non-WO moves.
    workOrderId: uuid('work_order_id'),
    at: timestamp('at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('stock_movements_item_id_idx').on(t.itemId),
    index('stock_movements_at_idx').on(t.at),
    index('stock_movements_work_order_id_idx').on(t.workOrderId),
  ],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type NewInventoryItem = typeof inventoryItems.$inferInsert;
export type StockMovement = typeof stockMovements.$inferSelect;
export type NewStockMovement = typeof stockMovements.$inferInsert;
