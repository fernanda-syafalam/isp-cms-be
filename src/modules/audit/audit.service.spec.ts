import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditLogEntry } from '../../infrastructure/database/schema/audit.schema';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

const withEntity: AuditLogEntry = {
  id: '00000000-0000-0000-0000-00000000a002',
  at: new Date('2026-06-15T02:30:00.000Z'),
  actor: 'staff@ashnet.id',
  action: 'customer.suspend',
  entity: 'Pelanggan',
  summary: 'Mengisolir pelanggan karena tunggakan',
  entityId: 'cust-1001',
};

const withoutEntity: AuditLogEntry = {
  id: '00000000-0000-0000-0000-00000000a001',
  at: new Date('2026-06-15T01:05:00.000Z'),
  actor: 'admin@ashnet.id',
  action: 'billing.run',
  entity: 'Tagihan',
  summary: 'Menjalankan penagihan massal',
  entityId: null,
};

describe('AuditService', () => {
  let service: AuditService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = { ensureSeeded: vi.fn(), list: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [AuditService, { provide: AuditRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(AuditService);
  });

  it('seeds on first read and maps rows to ISO timestamps', async () => {
    repo.list.mockResolvedValue({ items: [withEntity], total: 1 });
    const { items, total } = await service.list({ limit: 100, offset: 0 });
    expect(repo.ensureSeeded).toHaveBeenCalledTimes(1);
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      id: withEntity.id,
      action: 'customer.suspend',
      entityId: 'cust-1001',
      at: '2026-06-15T02:30:00.000Z',
    });
  });

  it('omits entityId (never null) when the row has none', async () => {
    repo.list.mockResolvedValue({ items: [withoutEntity], total: 1 });
    const { items } = await service.list({ limit: 100, offset: 0 });
    expect(items[0]).not.toHaveProperty('entityId');
  });

  it('forwards the entityId filter to the repo', async () => {
    repo.list.mockResolvedValue({ items: [withEntity], total: 1 });
    await service.list({ entityId: 'cust-1001', limit: 100, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({ entityId: 'cust-1001', limit: 100, offset: 0 });
  });

  it('forwards q, sort, and order to the repo unchanged', async () => {
    repo.list.mockResolvedValue({ items: [withEntity], total: 1 });
    await service.list({ q: 'admin', sort: 'actor', order: 'asc', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({
      q: 'admin',
      sort: 'actor',
      order: 'asc',
      limit: 50,
      offset: 0,
    });
  });

  it('forwards combined entityId + q filters to the repo', async () => {
    repo.list.mockResolvedValue({ items: [withEntity], total: 1 });
    await service.list({ entityId: 'cust-1001', q: 'suspend', limit: 100, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({
      entityId: 'cust-1001',
      q: 'suspend',
      limit: 100,
      offset: 0,
    });
  });
});
