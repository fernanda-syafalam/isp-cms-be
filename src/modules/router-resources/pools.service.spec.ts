import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutersRepository } from '../routers/routers.repository';
import { PoolsRepository } from './pools.repository';
import { PoolsService } from './pools.service';

const ROUTER_ID = '00000000-0000-0000-0000-00000000a101';

describe('PoolsService', () => {
  let service: PoolsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let routers: { findById: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = { listByRouter: vi.fn(), findById: vi.fn(), create: vi.fn(), remove: vi.fn() };
    routers = { findById: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PoolsService,
        { provide: PoolsRepository, useValue: repo },
        { provide: RoutersRepository, useValue: routers },
      ],
    }).compile();
    service = moduleRef.get(PoolsService);
  });

  it('create defaults totalAddresses to 253 and usedAddresses 0', async () => {
    routers.findById.mockResolvedValue({ id: ROUTER_ID });
    repo.create.mockResolvedValue({
      id: 'p1',
      routerId: ROUTER_ID,
      name: 'pppoe-pool',
      ranges: '10.10.0.2-10.10.0.254',
      totalAddresses: 253,
      usedAddresses: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await service.create(ROUTER_ID, {
      name: 'pppoe-pool',
      ranges: '10.10.0.2-10.10.0.254',
    });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ routerId: ROUTER_ID, totalAddresses: 253 }),
    );
    expect(result.usedAddresses).toBe(0);
  });

  it('remove 404 for a pool on another router', async () => {
    repo.findById.mockResolvedValue({ id: 'p1', routerId: 'other' });
    await expect(service.remove(ROUTER_ID, 'p1')).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.remove).not.toHaveBeenCalled();
  });
});
