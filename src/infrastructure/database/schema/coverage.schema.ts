import { index, integer, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const coverageType = pgEnum('coverage_type', ['pop', 'area']);
export const coverageStatus = pgEnum('coverage_status', ['operational', 'maintenance', 'down']);

// Service area / POP. `name` is UNIQUE so the reference rows can be
// idempotently seeded. customers.areaId points here (no FK wired yet).
export const coverageAreas = pgTable(
  'coverage_areas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 120 }).notNull().unique(),
    type: coverageType('type').notNull(),
    region: varchar('region', { length: 120 }).notNull(),
    capacity: integer('capacity').notNull(),
    activeConnections: integer('active_connections').notNull().default(0),
    status: coverageStatus('status').notNull().default('operational'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('coverage_areas_status_idx').on(t.status)],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type CoverageArea = typeof coverageAreas.$inferSelect;
export type NewCoverageArea = typeof coverageAreas.$inferInsert;
