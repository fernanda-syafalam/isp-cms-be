import { index, integer, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { resellers } from './resellers.schema';

// Sales pipeline stage. new -> survey -> quote -> won | lost.
export const leadStage = pgEnum('lead_stage', ['new', 'survey', 'quote', 'won', 'lost']);
export const leadSource = pgEnum('lead_source', ['walk_in', 'referral', 'online', 'reseller']);

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 120 }).notNull(),
    phone: varchar('phone', { length: 20 }).notNull(),
    address: varchar('address', { length: 255 }).notNull(),
    // Area + plan are stored by name (denormalized) — the lead is a
    // pre-subscriber record; the FKs are resolved at conversion time.
    areaName: varchar('area_name', { length: 120 }).notNull(),
    planName: varchar('plan_name', { length: 80 }).notNull(),
    stage: leadStage('stage').notNull().default('new'),
    // Estimated monthly value in whole IDR.
    estValue: integer('est_value').notNull(),
    source: leadSource('source').notNull(),
    note: varchar('note', { length: 500 }),
    // Acquisition channel (P3.D.2): which reseller/mitra brought this lead.
    // Propagated to customers.resellerId on convert (see leads.service#convert).
    resellerId: uuid('reseller_id').references(() => resellers.id),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('leads_stage_idx').on(t.stage),
    index('leads_created_at_idx').on(t.createdAt),
    index('leads_reseller_id_idx').on(t.resellerId),
  ],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
