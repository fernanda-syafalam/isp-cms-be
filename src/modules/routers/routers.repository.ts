import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewRouter,
  type Router,
  routers,
} from '../../infrastructure/database/schema/routers.schema';
import type { RouterSummary } from './dto/router-response.dto';

// Columns the frontend may sort on (camelCase key → Drizzle column).
// Unknown/absent key falls back to `createdAt desc` via buildOrderBy — never throws.
const ROUTERS_SORT_WHITELIST = {
  name: routers.name,
  address: routers.address,
  model: routers.model,
  secretCount: routers.secretCount,
  lastSyncAt: routers.lastSyncAt,
  status: routers.status,
  createdAt: routers.createdAt,
} satisfies Record<string, (typeof routers)[keyof typeof routers]>;

export interface RouterListFilter {
  status?: Router['status'];
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/**
 * The only place that talks to the `routers` table. Returns domain rows —
 * never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class RoutersRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async list(
    filter: RouterListFilter,
  ): Promise<{ items: Router[]; total: number; summary: RouterSummary }> {
    const where = and(
      filter.status ? eq(routers.status, filter.status) : undefined,
      filter.q
        ? or(
            ilike(routers.name, `%${filter.q}%`),
            ilike(routers.address, `%${filter.q}%`),
            ilike(routers.model, `%${filter.q}%`),
          )
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      ROUTERS_SORT_WHITELIST,
      desc(routers.createdAt),
    );

    const items = await this.db
      .select()
      .from(routers)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(routers).where(where);

    // Full-set status-count rollup — computed over ALL routers, ignoring
    // status/q/paging (mirrors the work-orders/invoices summary aggregate).
    // A single grouped-filter aggregate avoids 2 separate COUNT queries; a
    // missing status is zero-filled below.
    const [summaryRow] = await this.db
      .select({
        total: count(),
        online: sql<number>`count(*) filter (where ${routers.status} = 'online')`,
        offline: sql<number>`count(*) filter (where ${routers.status} = 'offline')`,
      })
      .from(routers);

    const summary: RouterSummary = {
      total: summaryRow?.total ?? 0,
      byStatus: {
        online: Number(summaryRow?.online ?? 0),
        offline: Number(summaryRow?.offline ?? 0),
      },
    };

    return { items, total: totals?.value ?? 0, summary };
  }

  async findById(id: string): Promise<Router | null> {
    const [row] = await this.db.select().from(routers).where(eq(routers.id, id)).limit(1);
    return row ?? null;
  }

  // The default router to provision new subscribers onto: lowest name first,
  // so the install cascade picks one deterministically. Null when none exist.
  async findFirst(): Promise<Router | null> {
    const [row] = await this.db.select().from(routers).orderBy(asc(routers.name)).limit(1);
    return row ?? null;
  }

  async create(input: NewRouter): Promise<Router> {
    const [row] = await this.db.insert(routers).values(input).returning();
    if (!row) {
      throw new Error('routers.insert returned no row');
    }
    return row;
  }

  // Partial patch (PATCH /v1/routers/:id). Caller (RoutersService) resolves
  // which fields to include — this only applies whatever it's given.
  async update(id: string, patch: Partial<NewRouter>): Promise<Router> {
    const [row] = await this.db
      .update(routers)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(routers.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('router not found');
    }
    return row;
  }

  // Move the cached secret count by delta (floored at 0). Maintained by the
  // PPPoE-secrets module as secrets are created/deleted.
  async adjustSecretCount(id: string, delta: number): Promise<void> {
    await this.db
      .update(routers)
      .set({
        secretCount: sql`greatest(0, ${routers.secretCount} + ${delta})`,
        updatedAt: sql`now()`,
      })
      .where(eq(routers.id, id));
  }

  // Record a successful sync: refresh lastSyncAt and mark online.
  async markSynced(id: string): Promise<Router> {
    const [row] = await this.db
      .update(routers)
      .set({ status: 'online', lastSyncAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(routers.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('router not found');
    }
    return row;
  }
}
