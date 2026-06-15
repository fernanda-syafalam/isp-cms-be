import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewSimpleQueue,
  type SimpleQueue,
  simpleQueues,
} from '../../infrastructure/database/schema/mikrotik-resources.schema';

type QueuePatch = Partial<Pick<NewSimpleQueue, 'name' | 'target' | 'maxLimit'>>;

/** The only place that talks to `simple_queues` (Pilar 3). */
@Injectable()
export class QueuesRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async listByRouter(routerId: string): Promise<{ items: SimpleQueue[]; total: number }> {
    const items = await this.db
      .select()
      .from(simpleQueues)
      .where(eq(simpleQueues.routerId, routerId))
      .orderBy(asc(simpleQueues.name));
    return { items, total: items.length };
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
