import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Branch } from '../../infrastructure/database/schema/branches.schema';
import { BranchesRepository } from './branches.repository';
import { BranchesService } from './branches.service';

const branch: Branch = {
  id: '00000000-0000-0000-0000-00000000a301',
  name: 'Cabang Pecangaan',
  city: 'Pecangaan',
  manager: 'Budi Hartono',
  phone: '0291-755221',
  status: 'active',
  isHeadOffice: false,
  customerCount: 0,
  mrr: 0,
  deviceCount: 0,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

const defaultSummary = { branches: 1, customers: 145, mrr: 41_000_000 };

describe('BranchesService', () => {
  let service: BranchesService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = { list: vi.fn(), create: vi.fn(), update: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [BranchesService, { provide: BranchesRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(BranchesService);
  });

  it('list maps branches with roll-up fields and forwards summary', async () => {
    repo.list.mockResolvedValue({
      items: [{ ...branch, customerCount: 145, mrr: 41_000_000 }],
      total: 1,
      summary: defaultSummary,
    });
    const result = await service.list({ limit: 50, offset: 0 });
    expect(result.items[0]?.customerCount).toBe(145);
    expect(result.items[0]?.mrr).toBe(41_000_000);
    expect(result.items[0]?.isHeadOffice).toBe(false);
    expect(result.summary).toEqual(defaultSummary);
  });

  it('forwards q, sort, and order to the repository', async () => {
    repo.list.mockResolvedValue({ items: [], total: 0, summary: defaultSummary });
    await service.list({ q: 'pecangaan', sort: 'mrr', order: 'desc', limit: 20, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({
      q: 'pecangaan',
      sort: 'mrr',
      order: 'desc',
      limit: 20,
      offset: 0,
    });
  });

  it('forwards status filter to the repository', async () => {
    repo.list.mockResolvedValue({ items: [], total: 0, summary: defaultSummary });
    await service.list({ status: 'inactive', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({ status: 'inactive', limit: 50, offset: 0 });
  });

  it('list returns total from repo (filtered count before paging)', async () => {
    repo.list.mockResolvedValue({
      items: [branch],
      total: 7,
      summary: defaultSummary,
    });
    const result = await service.list({ limit: 1, offset: 0 });
    // items has 1 entry but total is the full filtered count (7).
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(7);
  });

  it('summary is included even when items list is empty', async () => {
    repo.list.mockResolvedValue({
      items: [],
      total: 0,
      summary: { branches: 3, customers: 200, mrr: 10_000_000 },
    });
    const result = await service.list({ q: 'nonexistent', limit: 50, offset: 0 });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
    // Summary reflects ALL branches, not the empty filtered result.
    expect(result.summary.branches).toBe(3);
    expect(result.summary.customers).toBe(200);
    expect(result.summary.mrr).toBe(10_000_000);
  });

  it('create passes the input through', async () => {
    repo.create.mockResolvedValue(branch);
    await service.create({
      name: 'Cabang Pecangaan',
      city: 'Pecangaan',
      manager: 'Budi Hartono',
      phone: '0291-755221',
    });
    expect(repo.create).toHaveBeenCalledWith({
      name: 'Cabang Pecangaan',
      city: 'Pecangaan',
      manager: 'Budi Hartono',
      phone: '0291-755221',
    });
  });

  it('update can rename and deactivate in one call', async () => {
    repo.update.mockResolvedValue({ ...branch, name: 'Cabang Baru', status: 'inactive' });
    const result = await service.update(branch.id, { name: 'Cabang Baru', status: 'inactive' });
    expect(repo.update).toHaveBeenCalledWith(branch.id, {
      name: 'Cabang Baru',
      status: 'inactive',
    });
    expect(result.status).toBe('inactive');
  });
});
