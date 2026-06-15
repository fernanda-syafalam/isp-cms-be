import { index, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { routers } from './routers.schema';

// Simple Queue (bandwidth shaping) on a router.
export const simpleQueues = pgTable(
  'simple_queues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    routerId: uuid('router_id')
      .notNull()
      .references(() => routers.id),
    name: varchar('name', { length: 60 }).notNull(),
    target: varchar('target', { length: 60 }).notNull(),
    maxLimit: varchar('max_limit', { length: 40 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('simple_queues_router_id_idx').on(t.routerId)],
);

// IP Pool (PPPoE address provisioning) on a router.
export const ipPools = pgTable(
  'ip_pools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    routerId: uuid('router_id')
      .notNull()
      .references(() => routers.id),
    name: varchar('name', { length: 60 }).notNull(),
    ranges: varchar('ranges', { length: 120 }).notNull(),
    totalAddresses: integer('total_addresses').notNull().default(0),
    usedAddresses: integer('used_addresses').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('ip_pools_router_id_idx').on(t.routerId)],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type SimpleQueue = typeof simpleQueues.$inferSelect;
export type NewSimpleQueue = typeof simpleQueues.$inferInsert;
export type IpPool = typeof ipPools.$inferSelect;
export type NewIpPool = typeof ipPools.$inferInsert;
