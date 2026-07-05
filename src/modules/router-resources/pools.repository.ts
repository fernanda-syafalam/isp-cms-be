import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, count, eq } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type IpPool,
  type NewIpPool,
  ipPools,
} from '../../infrastructure/database/schema/mikrotik-resources.schema';

/** The only place that talks to `ip_pools` (Pilar 3). */
@Injectable()
export class PoolsRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async listByRouter(routerId: string): Promise<{ items: IpPool[]; total: number }> {
    const items = await this.db
      .select()
      .from(ipPools)
      .where(eq(ipPools.routerId, routerId))
      .orderBy(asc(ipPools.name));
    return { items, total: items.length };
  }

  async findById(id: string): Promise<IpPool | null> {
    const [row] = await this.db.select().from(ipPools).where(eq(ipPools.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * Count every pool across ALL routers. Used by the setup-status rollup
   * (P3.E.2) to tell "at least one router exists" apart from "IP pools are
   * actually provisioned" — `listByRouter` alone cannot answer that without
   * a router id.
   */
  async countAll(): Promise<number> {
    const [row] = await this.db.select({ value: count() }).from(ipPools);
    return row?.value ?? 0;
  }

  async create(input: NewIpPool): Promise<IpPool> {
    const [row] = await this.db.insert(ipPools).values(input).returning();
    if (!row) throw new Error('ip_pools.insert returned no row');
    return row;
  }

  async remove(id: string): Promise<void> {
    const result = await this.db.delete(ipPools).where(eq(ipPools.id, id));
    if (result.rowCount === 0) throw new NotFoundException('pool not found');
  }
}
