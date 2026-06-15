import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OdpRecordRow } from '../../infrastructure/database/schema/odp.schema';
import { OdpRepository } from './odp.repository';
import { OdpService } from './odp.service';

const row: OdpRecordRow = {
  id: '0d90d900-1111-4111-8111-000000000000',
  name: 'ODP-JEP-01',
  area: 'Jepara',
  splitter: '1:16',
  totalPorts: 16,
  usedPorts: 2,
  avgRxPowerDbm: -18,
  status: 'healthy',
  createdAt: new Date('2026-06-16T00:00:00.000Z'),
  updatedAt: new Date('2026-06-16T00:00:00.000Z'),
};

describe('OdpService', () => {
  let service: OdpService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = { ensureSeeded: vi.fn(), list: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [OdpService, { provide: OdpRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(OdpService);
  });

  it('seeds on first read and maps rows to the wire shape', async () => {
    repo.list.mockResolvedValue([row]);
    const { items, total } = await service.list();
    expect(repo.ensureSeeded).toHaveBeenCalledTimes(1);
    expect(total).toBe(1);
    expect(items[0]).toEqual({
      id: row.id,
      name: 'ODP-JEP-01',
      area: 'Jepara',
      splitter: '1:16',
      totalPorts: 16,
      usedPorts: 2,
      avgRxPowerDbm: -18,
      status: 'healthy',
    });
  });
});
