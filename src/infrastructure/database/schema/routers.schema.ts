import { index, integer, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const routerStatus = pgEnum('router_status', ['online', 'offline']);

// A managed Mikrotik (RouterOS) device. The API password is intentionally
// NOT stored here — credential storage (encrypted) lands with the real
// RouterOS API integration; this record holds the connection metadata only.
export const routers = pgTable(
  'routers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 80 }).notNull(),
    address: varchar('address', { length: 120 }).notNull(),
    apiPort: integer('api_port').notNull(),
    username: varchar('username', { length: 60 }).notNull(),
    model: varchar('model', { length: 60 }).notNull(),
    version: varchar('version', { length: 40 }).notNull(),
    status: routerStatus('status').notNull().default('online'),
    // Maintained by the PPPoE-secrets module as secrets are added/removed.
    secretCount: integer('secret_count').notNull().default(0),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('routers_status_idx').on(t.status)],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type Router = typeof routers.$inferSelect;
export type NewRouter = typeof routers.$inferInsert;
