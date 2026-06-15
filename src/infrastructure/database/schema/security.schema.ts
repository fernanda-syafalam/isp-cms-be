import { boolean, index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// Per-user account-security state backing the FE security page: the 2FA flag
// plus the active login sessions a user can review and revoke. Mock-first
// (ADR-0003): the real auth store hashes refresh tokens in Redis without
// per-user device/IP metadata, so the reviewable sessions are seeded here for
// display rather than derived from the token store.
export const userSecurity = pgTable('user_security', {
  // One row per user; the user id is the natural primary key.
  userId: uuid('user_id').primaryKey(),
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
});

export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    device: varchar('device', { length: 200 }).notNull(),
    ip: varchar('ip', { length: 60 }).notNull(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    // The session bound to the request that created it; never revoked by
    // "revoke other sessions".
    isCurrent: boolean('is_current').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('user_sessions_user_idx').on(t.userId)],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type UserSecurity = typeof userSecurity.$inferSelect;
export type NewUserSecurity = typeof userSecurity.$inferInsert;
export type UserSession = typeof userSessions.$inferSelect;
export type NewUserSession = typeof userSessions.$inferInsert;
