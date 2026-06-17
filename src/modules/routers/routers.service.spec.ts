import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from '../../infrastructure/database/schema/routers.schema';
import { RoutersRepository } from './routers.repository';
import { RoutersService } from './routers.service';

const router: Router = {
  id: '00000000-0000-0000-0000-00000000a101',
  name: 'Core-1',
  address: '10.0.0.1',
  apiPort: 8728,
  username: 'apiuser',
  model: 'RB5009',
  version: '7.15.3',
  status: 'online',
  secretCount: 0,
  lastSyncAt: new Date('2026-06-15T00:00:00.000Z'),
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

const connectInput = {
  name: 'Core-1',
  host: '10.0.0.1',
  apiPort: 8728,
  username: 'apiuser',
  password: 'secret',
  useTls: false,
};

describe('RoutersService', () => {
  let service: RoutersService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = { list: vi.fn(), findById: vi.fn(), create: vi.fn(), markSynced: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [RoutersService, { provide: RoutersRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(RoutersService);
  });

  it('testConnection returns a probe result without persisting', () => {
    const result = service.testConnection(connectInput);
    expect(result.ok).toBe(true);
    expect(result.identity).toBe('MikroTik-10.0.0.1');
    expect(result.model).toBeTypeOf('string');
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('connect maps host to address and synthesises model/version deterministically', async () => {
    repo.create.mockResolvedValue(router);
    await service.connect(connectInput);
    const arg = repo.create.mock.calls[0]?.[0];
    expect(arg.address).toBe('10.0.0.1');
    // deterministic: connect and a probe agree on model/version for a host
    const probe = service.testConnection(connectInput);
    expect(arg.model).toBe(probe.model);
    expect(arg.version).toBe(probe.version);
  });

  it('sync marks the router synced', async () => {
    repo.markSynced.mockResolvedValue({ ...router, status: 'online' });
    const result = await service.sync(router.id);
    expect(repo.markSynced).toHaveBeenCalledWith(router.id);
    expect(result.status).toBe('online');
  });

  it('reboot / test 404 on an unknown router', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.reboot('missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.test('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list maps routers and exposes secretCount + lastSyncAt', async () => {
    repo.list.mockResolvedValue({ items: [router], total: 1 });
    const result = await service.list({ limit: 50, offset: 0 });
    expect(result.items[0]?.secretCount).toBe(0);
    expect(result.items[0]?.lastSyncAt).toBe('2026-06-15T00:00:00.000Z');
  });

  it('forwards q to the repository', async () => {
    repo.list.mockResolvedValue({ items: [router], total: 1 });
    await service.list({ q: 'Core', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({ q: 'Core', limit: 50, offset: 0 });
  });

  it('forwards sort and order to the repository', async () => {
    repo.list.mockResolvedValue({ items: [router], total: 1 });
    await service.list({ sort: 'name', order: 'asc', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({ sort: 'name', order: 'asc', limit: 50, offset: 0 });
  });

  it('returns filtered total from the repository unchanged', async () => {
    repo.list.mockResolvedValue({ items: [router], total: 42 });
    const result = await service.list({ q: 'Core', limit: 10, offset: 0 });
    expect(result.total).toBe(42);
    expect(result.items).toHaveLength(1);
  });
});
