import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const routerStatus = pgEnum('router_status', ['online', 'offline']);

// A managed Mikrotik (RouterOS) device.
//
// SEC-M1 (SSRF + shared-credential exfiltration): the RouterOS API password
// used to be a single value shared across every router (env
// `ROUTEROS_API_PASSWORD`) — a staff-added router with a malicious `host`
// could exfiltrate it and control every other real device. `apiUsername` /
// `apiPasswordEncrypted` hold a PER-ROUTER credential instead (password
// encrypted at rest, AES-256-GCM — see `RouterCredentialCipherService`), so
// a compromised credential only ever exposes the one router it belongs to.
// Both are nullable: a router created before this migration (or one whose
// operator has not migrated it yet) has neither set, and the live adapter
// falls back to the shared env password for it (logging a warning nudge).
export const routers = pgTable(
  'routers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 80 }).notNull(),
    address: varchar('address', { length: 120 }).notNull(),
    apiPort: integer('api_port').notNull(),
    username: varchar('username', { length: 60 }).notNull(),
    // Optional override for the RouterOS API login user when it should
    // differ from `username` (e.g. a dedicated, minimally-privileged API
    // account). Falls back to `username` when unset.
    apiUsername: varchar('api_username', { length: 60 }),
    // AES-256-GCM ciphertext (`iv:authTag:ciphertext`, base64/colon-joined —
    // see `RouterCredentialCipherService`). NEVER the plaintext password and
    // NEVER returned by any API response (declared out of every response
    // DTO/schema, and the global ZodSerializer would strip it regardless).
    apiPasswordEncrypted: text('api_password_encrypted'),
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
