import { Injectable, NotFoundException } from '@nestjs/common';
import { count, desc, eq, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import { type Lead, type NewLead, leads } from '../../infrastructure/database/schema/leads.schema';

export interface LeadListFilter {
  stage?: Lead['stage'];
  limit: number;
  offset: number;
}

/**
 * The only place that talks to the `leads` table. Returns domain rows —
 * never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class LeadsRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async list(filter: LeadListFilter): Promise<{ items: Lead[]; total: number }> {
    const where = filter.stage ? eq(leads.stage, filter.stage) : undefined;
    const items = await this.db
      .select()
      .from(leads)
      .where(where)
      .orderBy(desc(leads.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(leads).where(where);
    return { items, total: totals?.value ?? 0 };
  }

  async findById(id: string): Promise<Lead | null> {
    const [row] = await this.db.select().from(leads).where(eq(leads.id, id)).limit(1);
    return row ?? null;
  }

  async create(input: NewLead): Promise<Lead> {
    const [row] = await this.db.insert(leads).values(input).returning();
    if (!row) {
      throw new Error('leads.insert returned no row');
    }
    return row;
  }

  async setStage(id: string, stage: Lead['stage']): Promise<Lead> {
    const [row] = await this.db
      .update(leads)
      .set({ stage, updatedAt: sql`now()` })
      .where(eq(leads.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('lead not found');
    }
    return row;
  }
}
