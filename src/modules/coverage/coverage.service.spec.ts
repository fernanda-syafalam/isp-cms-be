import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoverageArea } from '../../infrastructure/database/schema/coverage.schema';
import { CoverageRepository } from './coverage.repository';
import { CoverageService } from './coverage.service';

const area: CoverageArea = {
  id: '00000000-0000-0000-0000-00000000a401',
  name: 'POP Jepara',
  type: 'pop',
  region: 'Jawa Tengah',
  capacity: 500,
  activeConnections: 320,
  status: 'operational',
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('CoverageService', () => {
  let service: CoverageService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = { ensureSeeded: vi.fn(), list: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [CoverageService, { provide: CoverageRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(CoverageService);
  });

  it('seeds defaults then maps the coverage list', async () => {
    repo.list.mockResolvedValue({ items: [area], total: 1 });
    const result = await service.list({ limit: 100, offset: 0 });
    expect(repo.ensureSeeded).toHaveBeenCalledTimes(1);
    // the default set carries 8 areas alternating pop/area
    const defaults = repo.ensureSeeded.mock.calls[0]?.[0] as Array<{ type: string }>;
    expect(defaults).toHaveLength(8);
    expect(result.items[0]).toEqual({
      id: area.id,
      name: 'POP Jepara',
      type: 'pop',
      region: 'Jawa Tengah',
      capacity: 500,
      activeConnections: 320,
      status: 'operational',
    });
  });

  it('forwards q to the repository unchanged', async () => {
    repo.list.mockResolvedValue({ items: [area], total: 1 });
    await service.list({ q: 'Jepara', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'Jepara' }),
    );
  });

  it('forwards sort and order to the repository unchanged', async () => {
    repo.list.mockResolvedValue({ items: [], total: 0 });
    await service.list({ sort: 'capacity', order: 'desc', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'capacity', order: 'desc' }),
    );
  });

  it('forwards status + q combination to the repository', async () => {
    repo.list.mockResolvedValue({ items: [], total: 0 });
    await service.list({ status: 'operational', q: 'Jepara', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'operational', q: 'Jepara' }),
    );
  });
});
