import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, count, desc, eq, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewRouter,
  type Router,
  routers,
} from '../../infrastructure/database/schema/routers.schema';

export interface RouterListFilter {
  status?: Router['status'];
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

  async list(filter: RouterListFilter): Promise<{ items: Router[]; total: number }> {
    const where = filter.status ? eq(routers.status, filter.status) : undefined;
    const items = await this.db
      .select()
      .from(routers)
      .where(where)
      .orderBy(desc(routers.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(routers).where(where);
    return { items, total: totals?.value ?? 0 };
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
