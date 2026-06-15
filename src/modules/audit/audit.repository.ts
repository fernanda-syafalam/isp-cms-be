import { Injectable } from '@nestjs/common';
import { count, desc, eq } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type AuditLogEntry,
  type NewAuditLogEntry,
  auditLog,
} from '../../infrastructure/database/schema/audit.schema';

export interface AuditListFilter {
  entityId?: string;
  limit: number;
  offset: number;
}

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
    const where = filter.entityId ? eq(auditLog.entityId, filter.entityId) : undefined;
    const items = await this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.at))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(auditLog).where(where);
    return { items, total: totals?.value ?? 0 };
  }
}
