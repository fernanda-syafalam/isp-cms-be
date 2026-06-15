import { Injectable, NotFoundException } from '@nestjs/common';
import type { SimpleQueue } from '../../infrastructure/database/schema/mikrotik-resources.schema';
import { RoutersRepository } from '../routers/routers.repository';
import type { CreateQueueInput, QueueResponse, UpdateQueueInput } from './dto/queue.dto';
import { QueuesRepository } from './queues.repository';

@Injectable()
export class QueuesService {
  constructor(
    private readonly repo: QueuesRepository,
    private readonly routers: RoutersRepository,
  ) {}

  async list(routerId: string): Promise<{ items: QueueResponse[]; total: number }> {
    await this.requireRouter(routerId);
    const { items, total } = await this.repo.listByRouter(routerId);
    return { items: items.map(toQueueResponse), total };
  }

  async create(routerId: string, input: CreateQueueInput): Promise<QueueResponse> {
    await this.requireRouter(routerId);
    return toQueueResponse(await this.repo.create({ routerId, ...input }));
  }

  async update(routerId: string, id: string, input: UpdateQueueInput): Promise<QueueResponse> {
    await this.requireOwned(routerId, id);
    return toQueueResponse(await this.repo.update(id, input));
  }

  async remove(routerId: string, id: string): Promise<void> {
    await this.requireOwned(routerId, id);
    await this.repo.remove(id);
  }

  private async requireRouter(routerId: string): Promise<void> {
    if (!(await this.routers.findById(routerId))) throw new NotFoundException('router not found');
  }

  private async requireOwned(routerId: string, id: string): Promise<void> {
    const queue = await this.repo.findById(id);
    if (!queue || queue.routerId !== routerId) throw new NotFoundException('queue not found');
  }
}

function toQueueResponse(row: SimpleQueue): QueueResponse {
  return {
    id: row.id,
    routerId: row.routerId,
    name: row.name,
    target: row.target,
    maxLimit: row.maxLimit,
  };
}
