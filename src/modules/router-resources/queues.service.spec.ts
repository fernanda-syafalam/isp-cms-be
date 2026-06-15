import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutersRepository } from '../routers/routers.repository';
import { QueuesRepository } from './queues.repository';
import { QueuesService } from './queues.service';

const ROUTER_ID = '00000000-0000-0000-0000-00000000a101';
const queue = {
  id: '00000000-0000-0000-0000-00000000b201',
  routerId: ROUTER_ID,
  name: 'Q-Budi',
  target: '100.64.0.2',
  maxLimit: '20M/20M',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('QueuesService', () => {
  let service: QueuesService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let routers: { findById: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      listByRouter: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };
    routers = { findById: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        QueuesService,
        { provide: QueuesRepository, useValue: repo },
        { provide: RoutersRepository, useValue: routers },
      ],
    }).compile();
    service = moduleRef.get(QueuesService);
  });

  it('lists when the router exists', async () => {
    routers.findById.mockResolvedValue({ id: ROUTER_ID });
    repo.listByRouter.mockResolvedValue({ items: [queue], total: 1 });
    const result = await service.list(ROUTER_ID);
    expect(result.items[0]?.maxLimit).toBe('20M/20M');
  });

  it('404s on unknown router', async () => {
    routers.findById.mockResolvedValue(null);
    await expect(service.list(ROUTER_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('create attaches the router id', async () => {
    routers.findById.mockResolvedValue({ id: ROUTER_ID });
    repo.create.mockResolvedValue(queue);
    await service.create(ROUTER_ID, { name: 'Q-Budi', target: '100.64.0.2', maxLimit: '20M/20M' });
    expect(repo.create).toHaveBeenCalledWith({
      routerId: ROUTER_ID,
      name: 'Q-Budi',
      target: '100.64.0.2',
      maxLimit: '20M/20M',
    });
  });

  it('update/remove 404 for a queue on another router', async () => {
    repo.findById.mockResolvedValue({ ...queue, routerId: 'other' });
    await expect(service.update(ROUTER_ID, queue.id, { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.remove(ROUTER_ID, queue.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.remove).not.toHaveBeenCalled();
  });
});
