import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, count, eq, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type Branch,
  type NewBranch,
  branches,
} from '../../infrastructure/database/schema/branches.schema';

export interface BranchListFilter {
  status?: Branch['status'];
  limit: number;
  offset: number;
}

type BranchPatch = Partial<Pick<NewBranch, 'name' | 'city' | 'manager' | 'phone' | 'status'>>;

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

  async list(filter: BranchListFilter): Promise<{ items: Branch[]; total: number }> {
    const where = filter.status ? eq(branches.status, filter.status) : undefined;
    const items = await this.db
      .select()
      .from(branches)
      .where(where)
      .orderBy(asc(branches.name))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(branches).where(where);
    return { items, total: totals?.value ?? 0 };
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
