import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, ilike, or, sql, sum } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type Branch,
  type NewBranch,
  branches,
} from '../../infrastructure/database/schema/branches.schema';

export interface BranchListFilter {
  q?: string;
  status?: Branch['status'];
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface BranchSummary {
  branches: number;
  customers: number;
  mrr: number;
  byStatus: {
    active: number;
    inactive: number;
  };
}

type BranchPatch = Partial<Pick<NewBranch, 'name' | 'city' | 'manager' | 'phone' | 'status'>>;

// Columns the frontend is allowed to sort branches on (camelCase key → Drizzle column).
// Unknown/absent key falls back to `asc(branches.name)` via buildOrderBy — never throws.
const BRANCHES_SORT_WHITELIST = {
  name: branches.name,
  city: branches.city,
  customerCount: branches.customerCount,
  mrr: branches.mrr,
  status: branches.status,
} satisfies Record<string, (typeof branches)[keyof typeof branches]>;

/**
 * The only place that talks to the `branches` table. Returns domain rows —
 * never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class BranchesRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async list(
    filter: BranchListFilter,
  ): Promise<{ items: Branch[]; total: number; summary: BranchSummary }> {
    // WHERE clause for status + q (applied to items and filtered total).
    // Summary is computed over the full table — no where clause there.
    const where = and(
      filter.status ? eq(branches.status, filter.status) : undefined,
      filter.q
        ? or(
            ilike(branches.name, `%${filter.q}%`),
            ilike(branches.city, `%${filter.q}%`),
            ilike(branches.manager, `%${filter.q}%`),
          )
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      BRANCHES_SORT_WHITELIST,
      asc(branches.name),
    );

    const items = await this.db
      .select()
      .from(branches)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);

    const [totals] = await this.db.select({ value: count() }).from(branches).where(where);

    // Full-set summary — computed over ALL branches, ignoring q/status/paging
    // (a dashboard invariant: the KPI cards never change with filters).
    const [summaryRow] = await this.db
      .select({
        branchCount: count(),
        customers: sql<string>`coalesce(${sum(branches.customerCount)}, 0)`,
        mrr: sql<string>`coalesce(${sum(branches.mrr)}, 0)`,
        active: sql<number>`count(*) filter (where ${branches.status} = 'active')`,
        inactive: sql<number>`count(*) filter (where ${branches.status} = 'inactive')`,
      })
      .from(branches);

    const summary: BranchSummary = {
      branches: summaryRow?.branchCount ?? 0,
      customers: Number(summaryRow?.customers ?? 0),
      mrr: Number(summaryRow?.mrr ?? 0),
      byStatus: {
        active: Number(summaryRow?.active ?? 0),
        inactive: Number(summaryRow?.inactive ?? 0),
      },
    };

    return { items, total: totals?.value ?? 0, summary };
  }

  async create(input: NewBranch): Promise<Branch> {
    const [row] = await this.db.insert(branches).values(input).returning();
    if (!row) {
      throw new Error('branches.insert returned no row');
    }
    return row;
  }

  async update(id: string, patch: BranchPatch): Promise<Branch> {
    const [row] = await this.db
      .update(branches)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(branches.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('branch not found');
    }
    return row;
  }
}
