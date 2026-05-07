import { index, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', ['admin', 'staff', 'customer']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    fullName: varchar('full_name', { length: 120 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    role: userRole('role').notNull().default('customer'),
    // Millisecond precision matches what JS Date / cursor encoding can
    // represent, so cursor pagination predicates (lt(createdAt) etc.)
    // never miss rows whose stored microseconds differ from the
    // millisecond round-trip. Postgres default is microsecond — using
    // (3) here is a deliberate choice for cursor stability.
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, precision: 3 }),
  },
  (t) => [
    // Composite cursor pagination key — see UsersRepository.listPage.
    index('users_created_at_id_idx').on(t.createdAt, t.id),
  ],
);

// Domain types are derived from the schema. Never duplicated by hand —
// see Pilar 3 ("Type domain di-derive — JANGAN ditulis ulang").
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
