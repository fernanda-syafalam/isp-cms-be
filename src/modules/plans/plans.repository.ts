import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, ilike, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import { type NewPlan, type Plan, plans } from '../../infrastructure/database/schema/plans.schema';
import type { PlanSummary } from './dto/plan-response.dto';

// Repo-only slice of PlanSummary: everything computable from the `plans`
// table alone. `totalSubscribers` needs the customers table (a real
// active-subscriber count), so PlansService enriches this with a
// CustomersRepository call rather than PlansRepository reaching across
// tables (Pilar 3 — one repository per table).

// Columns the frontend may sort on (camelCase key → Drizzle column).
// `subscriberCount` is FE-only mock data with no backing column — it must
// never appear here.
// Unknown/absent key falls back to `name asc` via buildOrderBy — never throws.
const PLANS_SORT_WHITELIST = {
  name: plans.name,
  speedMbps: plans.speedMbps,
  priceMonthly: plans.priceMonthly,
  status: plans.status,
  createdAt: plans.createdAt,
} satisfies Record<string, (typeof plans)[keyof typeof plans]>;

export interface PlanListFilter {
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

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

  async list(
    filter: PlanListFilter,
  ): Promise<{ items: Plan[]; total: number; summary: Omit<PlanSummary, 'totalSubscribers'> }> {
    const where = and(filter.q ? ilike(plans.name, `%${filter.q}%`) : undefined);

    const orderBy = buildOrderBy(filter.sort, filter.order, PLANS_SORT_WHITELIST, asc(plans.name));

    const items = await this.db
      .select()
      .from(plans)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(plans).where(where);

    // Full-set status-count rollup — computed over ALL plans, ignoring
    // q/paging (mirrors the work-orders/invoices summary aggregate). A
    // single grouped-filter aggregate avoids 2 separate COUNT queries; a
    // missing status is zero-filled below.
    const [summaryRow] = await this.db
      .select({
        total: count(),
        active: sql<number>`count(*) filter (where ${plans.status} = 'active')`,
        archived: sql<number>`count(*) filter (where ${plans.status} = 'archived')`,
      })
      .from(plans);

    const summary: Omit<PlanSummary, 'totalSubscribers'> = {
      total: summaryRow?.total ?? 0,
      byStatus: {
        active: Number(summaryRow?.active ?? 0),
        archived: Number(summaryRow?.archived ?? 0),
      },
    };

    return { items, total: totals?.value ?? 0, summary };
  }

  async findById(id: string): Promise<Plan | null> {
    const [row] = await this.db.select().from(plans).where(eq(plans.id, id)).limit(1);
    return row ?? null;
  }

  // Resolve a plan from its display name — used when a caller references a
  // plan by name (e.g. converting a lead, which stores planName).
  async findByName(name: string): Promise<Plan | null> {
    const [row] = await this.db.select().from(plans).where(eq(plans.name, name)).limit(1);
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
