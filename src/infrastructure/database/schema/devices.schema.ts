import {
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const deviceType = pgEnum('device_type', ['olt', 'onu', 'mikrotik']);
export const deviceStatus = pgEnum('device_status', ['online', 'degraded', 'offline']);

// The managed network device fleet shown in the NOC view. Distinct from
// `inventory_items` (warehouse stock) and `routers` (RouterOS connection
// metadata): this is the operational health snapshot of deployed gear. A real
// backend hydrates it from GenieACS / SNMP polling; here it is seeded.
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Unique so the first-read seed is idempotent (onConflictDoNothing).
    name: varchar('name', { length: 120 }).notNull().unique(),
    type: deviceType('type').notNull(),
    ipAddress: varchar('ip_address', { length: 60 }).notNull(),
    status: deviceStatus('status').notNull().default('online'),
    uptimeHours: integer('uptime_hours').notNull().default(0),
    // Optical RX power in dBm — ONU only, null for OLT/Mikrotik.
    rxPower: doublePrecision('rx_power'),
    areaName: varchar('area_name', { length: 120 }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    // The matching topology node id (OLT), when one exists.
    topologyNodeId: varchar('topology_node_id', { length: 120 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('devices_status_idx').on(t.status), index('devices_type_idx').on(t.type)],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
