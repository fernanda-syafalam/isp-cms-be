import { doublePrecision, integer, pgEnum, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

// Optical health of an ODP, derived from its worst-case strand RX power.
export const odpStatus = pgEnum('odp_status', ['healthy', 'warning', 'critical']);

// FTTH distribution point capacity + optical health. A standalone capacity
// dashboard (separate from the topology node forest): the FE `GET /odp` reads a
// flat fixture, so this self-seeds its own deterministic rows (mock-first,
// ADR-0003). `id`/`name` are deterministic so seeding is idempotent.
export const odpRecords = pgTable('odp_records', {
  id: varchar('id', { length: 60 }).primaryKey(),
  name: varchar('name', { length: 80 }).notNull().unique(),
  area: varchar('area', { length: 120 }).notNull(),
  splitter: varchar('splitter', { length: 16 }).notNull(), // e.g. "1:8", "1:16"
  totalPorts: integer('total_ports').notNull(),
  usedPorts: integer('used_ports').notNull(),
  avgRxPowerDbm: doublePrecision('avg_rx_power_dbm').notNull(), // optical RX power, dBm (negative)
  status: odpStatus('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
});

// Domain types derived from the schema — never hand-written (Pilar 3).
export type OdpRecordRow = typeof odpRecords.$inferSelect;
export type NewOdpRecord = typeof odpRecords.$inferInsert;
