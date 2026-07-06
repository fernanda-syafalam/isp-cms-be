import { boolean, index, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const announcementSeverity = pgEnum('announcement_severity', ['info', 'warning', 'outage']);

// Portal-facing announcements/outage notices (P3.C.4). A customer sees only
// the active window (`listActive`); staff manage the full list (create,
// list, deactivate). Self-seeds a couple of fixture rows on first read,
// mirroring the acs/odp mock-first pattern (ADR-0003).
export const announcements = pgTable(
  'announcements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 160 }).notNull(),
    body: varchar('body', { length: 1000 }).notNull(),
    severity: announcementSeverity('severity').notNull().default('info'),
    active: boolean('active').notNull().default(true),
    // Optional visibility window — null means "no lower/upper bound".
    startsAt: timestamp('starts_at', { withTimezone: true, precision: 3 }),
    endsAt: timestamp('ends_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('announcements_active_idx').on(t.active)],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type Announcement = typeof announcements.$inferSelect;
export type NewAnnouncement = typeof announcements.$inferInsert;
