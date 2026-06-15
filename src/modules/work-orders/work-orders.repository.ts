import { Injectable, NotFoundException } from '@nestjs/common';
import { count, desc, eq, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewWorkOrder,
  type WorkOrder,
  workOrders,
} from '../../infrastructure/database/schema/work-orders.schema';

export interface WorkOrderListFilter {
  status?: WorkOrder['status'];
  limit: number;
  offset: number;
}

/**
 * The only place that talks to the `work_orders` table. Returns domain
 * rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class WorkOrdersRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async list(filter: WorkOrderListFilter): Promise<{ items: WorkOrder[]; total: number }> {
    const where = filter.status ? eq(workOrders.status, filter.status) : undefined;
    const items = await this.db
      .select()
      .from(workOrders)
      .where(where)
      .orderBy(desc(workOrders.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(workOrders).where(where);
    return { items, total: totals?.value ?? 0 };
  }

  async findById(id: string): Promise<WorkOrder | null> {
    const [row] = await this.db.select().from(workOrders).where(eq(workOrders.id, id)).limit(1);
    return row ?? null;
  }

  async create(input: NewWorkOrder): Promise<WorkOrder> {
    const [row] = await this.db.insert(workOrders).values(input).returning();
    if (!row) {
      throw new Error('work_orders.insert returned no row');
    }
    return row;
  }

  async markDone(id: string): Promise<WorkOrder> {
    const [row] = await this.db
      .update(workOrders)
      .set({ status: 'done', updatedAt: sql`now()` })
      .where(eq(workOrders.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('work order not found');
    }
    return row;
  }
}
