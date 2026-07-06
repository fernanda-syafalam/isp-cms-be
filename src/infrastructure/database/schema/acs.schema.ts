import { index, pgEnum, pgTable, real, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const acsStatus = pgEnum('acs_status', ['online', 'offline']);

// TR-069 managed CPE/ONU. customerName is denormalized (no typed FK in the
// FE contract). rxPowerDbm is the optical receive power (null when offline).
export const acsDevices = pgTable(
  'acs_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serial: varchar('serial', { length: 80 }).notNull().unique(),
    customerName: varchar('customer_name', { length: 120 }).notNull(),
    model: varchar('model', { length: 80 }).notNull(),
    firmware: varchar('firmware', { length: 40 }).notNull(),
    // Current WiFi SSID pushed to the CPE (portal self-care seam, P3.C.4).
    // Null until the first `setWifi` call — the CPE ships with a vendor
    // default SSID that this table never mirrors on seed.
    ssid: varchar('ssid', { length: 32 }),
    rxPowerDbm: real('rx_power_dbm'),
    status: acsStatus('status').notNull().default('online'),
    lastInform: timestamp('last_inform', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('acs_devices_status_idx').on(t.status)],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type AcsDevice = typeof acsDevices.$inferSelect;
export type NewAcsDevice = typeof acsDevices.$inferInsert;
