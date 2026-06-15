import { boolean, index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { customers } from './customers.schema';
import { routers } from './routers.schema';

// PPPoE / bandwidth profile on a router. isIsolir marks the throttle profile
// used when a subscriber is suspended for non-payment.
export const pppProfiles = pgTable(
  'ppp_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    routerId: uuid('router_id')
      .notNull()
      .references(() => routers.id),
    name: varchar('name', { length: 60 }).notNull(),
    rateLimit: varchar('rate_limit', { length: 40 }).notNull(),
    isIsolir: boolean('is_isolir').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('ppp_profiles_router_id_idx').on(t.routerId)],
);

// PPPoE secret (subscriber account) on a router. The account password is
// intentionally NOT stored — RouterOS owns it; this record is the mapping.
export const pppSecrets = pgTable(
  'ppp_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    routerId: uuid('router_id')
      .notNull()
      .references(() => routers.id),
    username: varchar('username', { length: 60 }).notNull(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => pppProfiles.id),
    profileName: varchar('profile_name', { length: 60 }).notNull(),
    customerId: uuid('customer_id').references(() => customers.id),
    customerName: varchar('customer_name', { length: 120 }),
    disabled: boolean('disabled').notNull().default(false),
    comment: varchar('comment', { length: 160 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('ppp_secrets_router_id_idx').on(t.routerId),
    index('ppp_secrets_customer_id_idx').on(t.customerId),
  ],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type PppProfile = typeof pppProfiles.$inferSelect;
export type NewPppProfile = typeof pppProfiles.$inferInsert;
export type PppSecret = typeof pppSecrets.$inferSelect;
export type NewPppSecret = typeof pppSecrets.$inferInsert;
