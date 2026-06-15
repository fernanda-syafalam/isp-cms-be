import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import { type NewPlan, type Plan, plans } from '../../infrastructure/database/schema/plans.schema';

/**
 * The only place that talks to the `plans` table. Service consumers get
 * domain `Plan` types — never Drizzle rows or raw SQL (Pilar 3).
 */
@Injectable()
export class PlansRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  // Plans are few and long-lived; a full ordered list (active + archived)
  // is fine — no cursor pagination needed.
  async findAll(): Promise<Plan[]> {
    return this.db.select().from(plans).orderBy(asc(plans.name));
  }

  async findById(id: string): Promise<Plan | null> {
    const [row] = await this.db.select().from(plans).where(eq(plans.id, id)).limit(1);
    return row ?? null;
  }

  async create(input: NewPlan): Promise<Plan> {
    const [row] = await this.db.insert(plans).values(input).returning();
    if (!row) {
      throw new Error('plans.insert returned no row');
    }
    return row;
  }

  async update(id: string, patch: Partial<NewPlan>): Promise<Plan> {
    const [row] = await this.db
      .update(plans)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(plans.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('plan not found');
    }
    return row;
  }

  // Archive is a status transition — the row stays so customers/invoices
  // that reference it keep resolving.
  async archive(id: string): Promise<Plan> {
    const [row] = await this.db
      .update(plans)
      .set({ status: 'archived', updatedAt: sql`now()` })
      .where(eq(plans.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('plan not found');
    }
    return row;
  }
}
