import { Injectable, NotFoundException } from '@nestjs/common';
import { count, desc, eq, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewSlaCredit,
  type SlaCredit,
  slaCredits,
} from '../../infrastructure/database/schema/sla-credits.schema';

export interface SlaCreditListFilter {
  status?: SlaCredit['status'];
  limit: number;
  offset: number;
}

/**
 * The only place that talks to the `sla_credits` table. Returns domain
 * rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class SlaCreditsRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async list(filter: SlaCreditListFilter): Promise<{ items: SlaCredit[]; total: number }> {
    const where = filter.status ? eq(slaCredits.status, filter.status) : undefined;
    const items = await this.db
      .select()
      .from(slaCredits)
      .where(where)
      .orderBy(desc(slaCredits.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(slaCredits).where(where);
    return { items, total: totals?.value ?? 0 };
  }

  async findById(id: string): Promise<SlaCredit | null> {
    const [row] = await this.db.select().from(slaCredits).where(eq(slaCredits.id, id)).limit(1);
    return row ?? null;
  }

  async create(input: NewSlaCredit): Promise<SlaCredit> {
    const [row] = await this.db.insert(slaCredits).values(input).returning();
    if (!row) {
      throw new Error('sla_credits.insert returned no row');
    }
    return row;
  }

  async apply(id: string): Promise<SlaCredit> {
    const [row] = await this.db
      .update(slaCredits)
      .set({ status: 'applied', appliedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(slaCredits.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('sla credit not found');
    }
    return row;
  }

  async void(id: string): Promise<SlaCredit> {
    const [row] = await this.db
      .update(slaCredits)
      .set({ status: 'void', updatedAt: sql`now()` })
      .where(eq(slaCredits.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('sla credit not found');
    }
    return row;
  }
}
