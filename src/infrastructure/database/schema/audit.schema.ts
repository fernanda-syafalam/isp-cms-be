import { index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// Read-only audit trail of mutating actions, backing the FE audit page. The
// runtime `@Audit('action')` interceptor currently writes to structured pino
// logs, not a queryable table, so this seeded table is the readable history
// (mock-first, ADR-0003). A real backend would have the interceptor persist
// here. `entity_id` is indexed for the per-record history filter.
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    actor: varchar('actor', { length: 200 }).notNull(),
    action: varchar('action', { length: 120 }).notNull(),
    entity: varchar('entity', { length: 120 }).notNull(),
    summary: varchar('summary', { length: 500 }).notNull(),
    // The affected record id, when the action targets one. Nullable.
    entityId: varchar('entity_id', { length: 120 }),
  },
  (t) => [index('audit_log_entity_id_idx').on(t.entityId), index('audit_log_at_idx').on(t.at)],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
