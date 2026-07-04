import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { plans } from './plans.schema';
import { users } from './users.schema';

// Subscriber lifecycle. prospek -> instalasi -> aktif <-> isolir, and
// berhenti (churn). Values are the API enum — never translated here; the
// UI maps them to Indonesian labels at the display boundary.
export const customerStatus = pgEnum('customer_status', [
  'prospek',
  'instalasi',
  'aktif',
  'isolir',
  'berhenti',
]);

// Human-friendly account number: CUST-9001, CUST-9002, ... Backed by a
// sequence so concurrent inserts never collide (a count(*) + 1 would).
export const customerNoSeq = pgSequence('customer_no_seq', { startWith: 9001 });

// Provisioning snapshot, written by the work-order / network side when a
// customer is provisioned. Stored as JSON because the customers module
// does not (yet) own a normalized connection table — when a dedicated
// provisioning module lands this moves out. `null` until provisioned.
export type CustomerConnection = {
  type: 'pppoe' | 'gpon';
  pppoeUsername: string;
  profile: string;
  ipAddress: string;
  onuSerial: string | null;
  olt: string | null;
  ponPort: string | null;
  rxPower: number | null;
};

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerNo: varchar('customer_no', { length: 32 })
      .notNull()
      .unique()
      .default(sql`'CUST-' || nextval('customer_no_seq')`),
    fullName: varchar('full_name', { length: 120 }).notNull(),
    phone: varchar('phone', { length: 20 }).notNull(),
    email: varchar('email', { length: 255 }),
    // Portal login linkage (P1.3, ADR-0005): the subscriber's user account.
    // Unique — one login maps to at most one subscriber. Null until the
    // login is provisioned (onboarding does this; legacy rows use the
    // email fallback in resolveForPortal during the transition).
    userId: uuid('user_id')
      .unique()
      .references(() => users.id),
    address: varchar('address', { length: 255 }).notNull(),
    // Area is denormalized and nullable until a dedicated areas/coverage
    // module owns it. areaName is the label shown in the UI.
    areaId: uuid('area_id'),
    areaName: varchar('area_name', { length: 120 }),
    // Every subscriber signs up for a plan. FK to plans; a plan row
    // survives archival (status transition, not delete) so this never
    // dangles. planName is NOT stored — it is joined from plans (single
    // source of truth, Pilar 4).
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    status: customerStatus('status').notNull().default('prospek'),
    // Outstanding balance in whole IDR.
    outstanding: integer('outstanding').notNull().default(0),
    npwp: varchar('npwp', { length: 40 }),
    ktp: varchar('ktp', { length: 32 }),
    // UU PDP (Indonesian data-protection law) consent timestamp.
    consentAt: timestamp('consent_at', { withTimezone: true, precision: 3 }),
    // Set when an erasure (UU PDP / GDPR) is requested; an async worker
    // performs the actual anonymization — out of scope for this module.
    dataDeletionRequestedAt: timestamp('data_deletion_requested_at', {
      withTimezone: true,
      precision: 3,
    }),
    resellerName: varchar('reseller_name', { length: 120 }),
    connection: jsonb('connection').$type<CustomerConnection>(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('customers_status_idx').on(t.status),
    index('customers_full_name_idx').on(t.fullName),
    index('customers_plan_id_idx').on(t.planId),
  ],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
