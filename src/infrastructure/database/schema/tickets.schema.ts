import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgSequence,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { customers } from './customers.schema';

// open -> in_progress -> resolved; breached is set when a ticket is
// resolved after its SLA deadline (or otherwise misses it).
export const ticketStatus = pgEnum('ticket_status', [
  'open',
  'in_progress',
  'resolved',
  'breached',
]);
export const ticketPriority = pgEnum('ticket_priority', ['low', 'medium', 'high', 'urgent']);
// Timeline entry kinds.
export const ticketEventKind = pgEnum('ticket_event_kind', [
  'created',
  'comment',
  'status',
  'assign',
  'workorder',
  'csat',
]);
// Portal-facing report category (P3.C.2) — lets the customer classify the
// issue on submit instead of staff guessing from free text.
export const ticketCategory = pgEnum('ticket_category', [
  'koneksi_putus',
  'lambat',
  'tagihan',
  'perangkat',
  'lainnya',
]);

// TKT-2001, TKT-2002, ... from a sequence so codes never collide.
export const ticketCodeSeq = pgSequence('ticket_code_seq', { startWith: 2001 });

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 32 })
      .notNull()
      .unique()
      .default(sql`'TKT-' || nextval('ticket_code_seq')`),
    subject: varchar('subject', { length: 160 }).notNull(),
    // Nullable: a ticket may be opened against a name that does not match
    // a known subscriber. customerName is always the displayed label.
    customerId: uuid('customer_id').references(() => customers.id),
    customerName: varchar('customer_name', { length: 120 }).notNull(),
    priority: ticketPriority('priority').notNull(),
    status: ticketStatus('status').notNull().default('open'),
    // Free-text agent/staff name, not an FK (matches the FE contract).
    assignee: varchar('assignee', { length: 120 }),
    // Deadline = createdAt + SLA hours for the priority; recomputed when
    // the priority changes.
    slaDueAt: timestamp('sla_due_at', {
      withTimezone: true,
      precision: 3,
    }).notNull(),
    // Portal report + CSAT (P3.C.2) — all nullable: category/photo are only
    // set for portal-reported tickets, and CSAT is only set once the
    // customer rates a resolved/breached ticket.
    category: ticketCategory('category'),
    photoUrl: varchar('photo_url', { length: 500 }),
    csatRating: integer('csat_rating'),
    csatComment: varchar('csat_comment', { length: 500 }),
    csatAt: timestamp('csat_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('tickets_status_idx').on(t.status),
    index('tickets_customer_id_idx').on(t.customerId),
    index('tickets_created_at_idx').on(t.createdAt),
  ],
);

export const ticketEvents = pgTable(
  'ticket_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    kind: ticketEventKind('kind').notNull(),
    author: varchar('author', { length: 120 }).notNull(),
    body: varchar('body', { length: 500 }).notNull(),
    at: timestamp('at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('ticket_events_ticket_id_idx').on(t.ticketId)],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
export type TicketEvent = typeof ticketEvents.$inferSelect;
export type NewTicketEvent = typeof ticketEvents.$inferInsert;
