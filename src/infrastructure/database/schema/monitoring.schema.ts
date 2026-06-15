import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  real,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const metricStatus = pgEnum('metric_status', ['up', 'degraded', 'down']);
export const alertSeverity = pgEnum('alert_severity', ['warning', 'critical']);

// NOC device-health telemetry. Keyed by deviceId (one current metric per
// device). deviceId is not FK'd to a devices table (that module is separate).
export const deviceMetrics = pgTable('device_metrics', {
  deviceId: uuid('device_id').primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  type: varchar('type', { length: 40 }).notNull(),
  areaName: varchar('area_name', { length: 120 }).notNull(),
  status: metricStatus('status').notNull(),
  uptimePct: real('uptime_pct').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  utilizationPct: integer('utilization_pct').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
});

// NOC alerts raised against a device.
export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id').notNull(),
    deviceName: varchar('device_name', { length: 120 }).notNull(),
    severity: alertSeverity('severity').notNull(),
    message: varchar('message', { length: 255 }).notNull(),
    at: timestamp('at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    acknowledged: boolean('acknowledged').notNull().default(false),
  },
  (t) => [index('alerts_at_idx').on(t.at), index('alerts_acknowledged_idx').on(t.acknowledged)],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type DeviceMetric = typeof deviceMetrics.$inferSelect;
export type NewDeviceMetric = typeof deviceMetrics.$inferInsert;
export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
