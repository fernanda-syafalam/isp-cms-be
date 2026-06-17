import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewNotificationLogEntry,
  type NewNotificationTemplate,
  type NotificationLogEntry,
  type NotificationTemplate,
  notificationLog,
  notificationTemplates,
} from '../../infrastructure/database/schema/notifications.schema';

// Columns the frontend may sort on (camelCase key → Drizzle column).
// `to` is the FE field name for the `recipient` column.
// Unknown/absent key falls back to `at desc` via buildOrderBy — never throws.
const NOTIFICATION_LOG_SORT_WHITELIST = {
  at: notificationLog.at,
  to: notificationLog.recipient,
  templateName: notificationLog.templateName,
  status: notificationLog.status,
} satisfies Record<string, (typeof notificationLog)[keyof typeof notificationLog]>;

export interface LogListFilter {
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

type TemplatePatch = Partial<Pick<NewNotificationTemplate, 'body' | 'enabled'>>;

/**
 * The only place that talks to `notification_templates` / `notification_log`.
 * Returns domain rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class NotificationsRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  // Insert any missing default templates (idempotent — event is unique).
  async ensureSeeded(defaults: NewNotificationTemplate[]): Promise<void> {
    if (defaults.length === 0) return;
    await this.db.insert(notificationTemplates).values(defaults).onConflictDoNothing();
  }

  async listTemplates(): Promise<{ items: NotificationTemplate[]; total: number }> {
    const items = await this.db
      .select()
      .from(notificationTemplates)
      .orderBy(asc(notificationTemplates.name));
    return { items, total: items.length };
  }

  async findTemplateByEvent(
    event: NotificationTemplate['event'],
  ): Promise<NotificationTemplate | null> {
    const [row] = await this.db
      .select()
      .from(notificationTemplates)
      .where(eq(notificationTemplates.event, event))
      .limit(1);
    return row ?? null;
  }

  async updateTemplate(id: string, patch: TemplatePatch): Promise<NotificationTemplate> {
    const [row] = await this.db
      .update(notificationTemplates)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(notificationTemplates.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('template not found');
    }
    return row;
  }

  // --- Log ------------------------------------------------------------

  async listLog(filter: LogListFilter): Promise<{ items: NotificationLogEntry[]; total: number }> {
    const where = filter.q
      ? or(
          ilike(notificationLog.recipient, `%${filter.q}%`),
          ilike(notificationLog.templateName, `%${filter.q}%`),
        )
      : undefined;

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      NOTIFICATION_LOG_SORT_WHITELIST,
      desc(notificationLog.at),
    );

    const items = await this.db
      .select()
      .from(notificationLog)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(notificationLog).where(where);
    return { items, total: totals?.value ?? 0 };
  }

  async addLog(input: NewNotificationLogEntry): Promise<NotificationLogEntry> {
    const [row] = await this.db.insert(notificationLog).values(input).returning();
    if (!row) {
      throw new Error('notification_log.insert returned no row');
    }
    return row;
  }
}
