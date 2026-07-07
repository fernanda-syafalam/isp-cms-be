import { boolean, index, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const notificationEvent = pgEnum('notification_event', [
  'invoice_created',
  'due_soon',
  'overdue',
  'isolir',
  'paid',
  'ticket_update',
  'wo_scheduled',
  'wo_done',
]);
export const notificationStatus = pgEnum('notification_status', ['sent', 'failed']);

// One editable template per event. channel is WhatsApp-only for now.
export const notificationTemplates = pgTable('notification_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  event: notificationEvent('event').notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  channel: varchar('channel', { length: 20 }).notNull().default('whatsapp'),
  body: varchar('body', { length: 1000 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
});

// Append-only send log; `body` is the rendered message (placeholders
// already substituted at send time). `recipient` maps to the FE `to` field.
export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipient: varchar('recipient', { length: 20 }).notNull(),
    templateName: varchar('template_name', { length: 120 }).notNull(),
    channel: varchar('channel', { length: 20 }).notNull().default('whatsapp'),
    status: notificationStatus('status').notNull().default('sent'),
    body: varchar('body', { length: 1000 }).notNull(),
    at: timestamp('at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('notification_log_at_idx').on(t.at)],
);

// Domain types derived from the schema — never hand-written (Pilar 3).
export type NotificationTemplate = typeof notificationTemplates.$inferSelect;
export type NewNotificationTemplate = typeof notificationTemplates.$inferInsert;
export type NotificationLogEntry = typeof notificationLog.$inferSelect;
export type NewNotificationLogEntry = typeof notificationLog.$inferInsert;
