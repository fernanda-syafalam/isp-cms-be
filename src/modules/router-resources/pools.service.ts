import { Injectable, NotFoundException } from '@nestjs/common';
import type { IpPool } from '../../infrastructure/database/schema/mikrotik-resources.schema';
import { RoutersRepository } from '../routers/routers.repository';
import type { CreatePoolInput, PoolResponse } from './dto/pool.dto';
import { PoolsRepository } from './pools.repository';

// A /24 pool minus network/broadcast/gateway ≈ 253 usable addresses.
const DEFAULT_TOTAL_ADDRESSES = 253;

@Injectable()
export class PoolsService {
  constructor(
    private readonly repo: PoolsRepository,
    private readonly routers: RoutersRepository,
  ) {}

  async list(routerId: string): Promise<{ items: PoolResponse[]; total: number }> {
    await this.requireRouter(routerId);
    const { items, total } = await this.repo.listByRouter(routerId);
    return { items: items.map(toPoolResponse), total };
  }

  async create(routerId: string, input: CreatePoolInput): Promise<PoolResponse> {
    await this.requireRouter(routerId);
    const pool = await this.repo.create({
      routerId,
      name: input.name,
      ranges: input.ranges,
      totalAddresses: DEFAULT_TOTAL_ADDRESSES,
    });
    return toPoolResponse(pool);
  }

  async remove(routerId: string, id: string): Promise<void> {
    const pool = await this.repo.findById(id);
    if (!pool || pool.routerId !== routerId) throw new NotFoundException('pool not found');
    await this.repo.remove(id);
  }

  private async requireRouter(routerId: string): Promise<void> {
    if (!(await this.routers.findById(routerId))) throw new NotFoundException('router not found');
  }
}

function toPoolResponse(row: IpPool): PoolResponse {
  return {
    id: row.id,
    routerId: row.routerId,
    name: row.name,
    ranges: row.ranges,
    totalAddresses: row.totalAddresses,
    usedAddresses: row.usedAddresses,
  };
}
