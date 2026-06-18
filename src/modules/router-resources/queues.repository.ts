import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, ilike, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewSimpleQueue,
  type SimpleQueue,
  simpleQueues,
} from '../../infrastructure/database/schema/mikrotik-resources.schema';

type QueuePatch = Partial<Pick<NewSimpleQueue, 'name' | 'target' | 'maxLimit'>>;

export interface QueueListFilter {
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  offset: number;
}

// Columns the frontend is allowed to sort queues on (camelCase key → Drizzle column).
// Unknown/absent key falls back to `asc(simpleQueues.name)` via buildOrderBy.
const QUEUES_SORT_WHITELIST = {
  name: simpleQueues.name,
  target: simpleQueues.target,
  maxLimit: simpleQueues.maxLimit,
} satisfies Record<string, (typeof simpleQueues)[keyof typeof simpleQueues]>;

/** The only place that talks to `simple_queues` (Pilar 3). */
@Injectable()
export class QueuesRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async listByRouter(
    routerId: string,
    filter?: QueueListFilter,
  ): Promise<{ items: SimpleQueue[]; total: number }> {
    const where = and(
      eq(simpleQueues.routerId, routerId),
      filter?.q
        ? or(ilike(simpleQueues.name, `%${filter.q}%`), ilike(simpleQueues.target, `%${filter.q}%`))
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter?.sort,
      filter?.order,
      QUEUES_SORT_WHITELIST,
      asc(simpleQueues.name),
    );

    // When no filter is supplied (or no limit), return all matching rows ordered by name.
    if (!filter || filter.limit === undefined) {
      const items = await this.db.select().from(simpleQueues).where(where).orderBy(orderBy);

      const [countRow] = await this.db.select({ value: count() }).from(simpleQueues).where(where);
      const total = countRow?.value ?? items.length;

      // Apply offset even when no limit is specified (spec: "still apply offset").
      const offset = filter?.offset ?? 0;
      return { items: offset > 0 ? items.slice(offset) : items, total };
    }

    const items = await this.db
      .select()
      .from(simpleQueues)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);

    const [countRow] = await this.db.select({ value: count() }).from(simpleQueues).where(where);

    return { items, total: countRow?.value ?? 0 };
  }

  async findById(id: string): Promise<SimpleQueue | null> {
    const [row] = await this.db.select().from(simpleQueues).where(eq(simpleQueues.id, id)).limit(1);
    return row ?? null;
  }

  async create(input: NewSimpleQueue): Promise<SimpleQueue> {
    const [row] = await this.db.insert(simpleQueues).values(input).returning();
    if (!row) throw new Error('simple_queues.insert returned no row');
    return row;
  }

  async update(id: string, patch: QueuePatch): Promise<SimpleQueue> {
    const [row] = await this.db
      .update(simpleQueues)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(simpleQueues.id, id))
      .returning();
    if (!row) throw new NotFoundException('queue not found');
    return row;
  }

  async remove(id: string): Promise<void> {
    const result = await this.db.delete(simpleQueues).where(eq(simpleQueues.id, id));
    if (result.rowCount === 0) throw new NotFoundException('queue not found');
  }
}
