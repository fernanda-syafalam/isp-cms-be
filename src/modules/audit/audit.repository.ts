import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, or } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type AuditLogEntry,
  type NewAuditLogEntry,
  auditLog,
} from '../../infrastructure/database/schema/audit.schema';

export interface AuditListFilter {
  entityId?: string;
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

// Columns the frontend is allowed to sort on (camelCase key → Drizzle column).
// Extend this map as new sortable columns are added; never pass arbitrary
// column references — the whitelist is the security boundary.
const AUDIT_SORT_WHITELIST = {
  at: auditLog.at,
  actor: auditLog.actor,
  action: auditLog.action,
  entity: auditLog.entity,
} satisfies Record<string, (typeof auditLog)[keyof typeof auditLog]>;

/**
 * The only place that talks to the `audit_log` table. Returns domain rows
 * (Pilar 3). Read-only apart from the idempotent first-read seed.
 */
@Injectable()
export class AuditRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  // Seed the trail on first read. Defaults carry fixed ids so the insert is
  // idempotent on the primary key (onConflictDoNothing).
  async ensureSeeded(defaults: NewAuditLogEntry[]): Promise<void> {
    if (defaults.length === 0) return;
    await this.db.insert(auditLog).values(defaults).onConflictDoNothing();
  }

  async list(filter: AuditListFilter): Promise<{ items: AuditLogEntry[]; total: number }> {
    const where = and(
      filter.entityId ? eq(auditLog.entityId, filter.entityId) : undefined,
      filter.q
        ? or(
            ilike(auditLog.actor, `%${filter.q}%`),
            ilike(auditLog.action, `%${filter.q}%`),
            ilike(auditLog.entity, `%${filter.q}%`),
            ilike(auditLog.summary, `%${filter.q}%`),
          )
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      AUDIT_SORT_WHITELIST,
      desc(auditLog.at),
    );

    const items = await this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(auditLog).where(where);
    return { items, total: totals?.value ?? 0 };
  }
}
