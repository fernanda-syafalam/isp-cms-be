import { boolean, index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// Per-user account-security state backing the FE security page: the 2FA flag
// plus the active login sessions a user can review and revoke. Mock-first
// (ADR-0003): the real auth store hashes refresh tokens in Redis without
// per-user device/IP metadata, so the reviewable sessions are seeded here for
// display rather than derived from the token store.
export const userSecurity = pgTable('user_security', {
  // One row per user; the user id is the natural primary key.
  userId: uuid('user_id').primaryKey(),
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  // AES-256-GCM-encrypted TOTP secret (F2) — null until enrollment starts.
  // Stored as `iv:authTag:ciphertext` (base64, colon-joined); the
  // underlying plaintext is a base32 (RFC 4648) secret. `TotpSecretCipherService`
  // is the only encrypt/decrypt boundary — this column never holds
  // plaintext going forward. `text` (not a fixed `varchar`) because the
  // encrypted blob is longer than the old 64-char plaintext secret and has
  // no natural fixed max (migration 0046 widened this column from
  // `varchar(64)`, which used to hold the plaintext secret directly).
  //
  // A row can hold a secret with `twoFactorEnabled = false` while
  // enrollment is in-progress and unconfirmed; only `confirmTwoFactor`
  // (after a valid code) flips the flag. This is the single source of
  // truth for both the secret and the enabled state — do not duplicate
  // either on `users`.
  twoFactorSecret: text('two_factor_secret'),
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
