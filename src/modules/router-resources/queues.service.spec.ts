import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutersRepository } from '../routers/routers.repository';
import { QueuesRepository } from './queues.repository';
import type { QueueListFilter } from './queues.service';
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
const queue2 = {
  id: '00000000-0000-0000-0000-00000000b202',
  routerId: ROUTER_ID,
  name: 'Q-Anom',
  target: '100.64.1.5',
  maxLimit: '10M/10M',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const DEFAULT_FILTER: QueueListFilter = { offset: 0 };

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

  describe('list', () => {
    it('unfiltered total equals items length when all rows returned', async () => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      repo.listByRouter.mockResolvedValue({ items: [queue, queue2], total: 2 });
      const result = await service.list(ROUTER_ID, DEFAULT_FILTER);
      expect(result.total).toBe(result.items.length);
      expect(result.total).toBe(2);
    });

    it('passes filter to repository unchanged', async () => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      repo.listByRouter.mockResolvedValue({ items: [queue], total: 1 });
      const filter: QueueListFilter = {
        q: 'budi',
        sort: 'name',
        order: 'asc',
        limit: 10,
        offset: 0,
      };
      await service.list(ROUTER_ID, filter);
      expect(repo.listByRouter).toHaveBeenCalledWith(ROUTER_ID, filter);
    });

    it('q search over name (case-insensitive) — passes filter to repo', async () => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      repo.listByRouter.mockResolvedValue({ items: [queue], total: 1 });
      const filter: QueueListFilter = { q: 'BUDI', offset: 0 };
      const result = await service.list(ROUTER_ID, filter);
      expect(repo.listByRouter).toHaveBeenCalledWith(ROUTER_ID, filter);
      expect(result.total).toBe(1);
    });

    it('q search over target (case-insensitive) — passes filter to repo', async () => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      repo.listByRouter.mockResolvedValue({ items: [queue], total: 1 });
      const filter: QueueListFilter = { q: '100.64', offset: 0 };
      await service.list(ROUTER_ID, filter);
      expect(repo.listByRouter).toHaveBeenCalledWith(ROUTER_ID, filter);
    });

    it('sort by name asc — passes filter to repo', async () => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      repo.listByRouter.mockResolvedValue({ items: [queue2, queue], total: 2 });
      const filter: QueueListFilter = { sort: 'name', order: 'asc', offset: 0 };
      await service.list(ROUTER_ID, filter);
      expect(repo.listByRouter).toHaveBeenCalledWith(ROUTER_ID, filter);
    });

    it('sort by name desc — passes filter to repo', async () => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      repo.listByRouter.mockResolvedValue({ items: [queue, queue2], total: 2 });
      const filter: QueueListFilter = { sort: 'name', order: 'desc', offset: 0 };
      await service.list(ROUTER_ID, filter);
      expect(repo.listByRouter).toHaveBeenCalledWith(ROUTER_ID, filter);
    });

    it('sort by target — passes filter to repo', async () => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      repo.listByRouter.mockResolvedValue({ items: [queue, queue2], total: 2 });
      const filter: QueueListFilter = { sort: 'target', order: 'asc', offset: 0 };
      await service.list(ROUTER_ID, filter);
      expect(repo.listByRouter).toHaveBeenCalledWith(ROUTER_ID, filter);
    });

    it('sort by maxLimit — passes filter to repo', async () => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      repo.listByRouter.mockResolvedValue({ items: [queue2, queue], total: 2 });
      const filter: QueueListFilter = { sort: 'maxLimit', order: 'asc', offset: 0 };
      await service.list(ROUTER_ID, filter);
      expect(repo.listByRouter).toHaveBeenCalledWith(ROUTER_ID, filter);
    });

    it('sort whitelist fallback — unknown sort key passes through to repo (repo handles fallback)', async () => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      repo.listByRouter.mockResolvedValue({ items: [queue], total: 1 });
      // Unknown sort key — service passes it to repo, repo falls back to default (name asc)
      const filter: QueueListFilter = { sort: 'unknownColumn', order: 'asc', offset: 0 };
      await service.list(ROUTER_ID, filter);
      expect(repo.listByRouter).toHaveBeenCalledWith(ROUTER_ID, filter);
    });

    it('limit/offset paging — total reports full filtered count, not page size', async () => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      // Simulate: 5 total rows matching the filter, but only 2 returned on this page
      repo.listByRouter.mockResolvedValue({ items: [queue, queue2], total: 5 });
      const filter: QueueListFilter = { limit: 2, offset: 2 };
      const result = await service.list(ROUTER_ID, filter);
      expect(result.items.length).toBe(2);
      expect(result.total).toBe(5); // full filtered count, not page size
    });

    it('maps DB rows to QueueResponse shape without extra DB fields', async () => {
      routers.findById.mockResolvedValue({ id: ROUTER_ID });
      repo.listByRouter.mockResolvedValue({ items: [queue], total: 1 });
      const result = await service.list(ROUTER_ID, DEFAULT_FILTER);
      const item = result.items[0];
      expect(item).toEqual({
        id: queue.id,
        routerId: queue.routerId,
        name: queue.name,
        target: queue.target,
        maxLimit: queue.maxLimit,
      });
      // Timestamps must not leak into response
      expect(item).not.toHaveProperty('createdAt');
      expect(item).not.toHaveProperty('updatedAt');
    });

    it('404s on unknown router', async () => {
      routers.findById.mockResolvedValue(null);
      await expect(service.list(ROUTER_ID, DEFAULT_FILTER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
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
