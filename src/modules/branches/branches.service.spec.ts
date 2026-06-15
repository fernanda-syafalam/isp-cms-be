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

  it('list maps branches with roll-up fields', async () => {
    repo.list.mockResolvedValue({
      items: [{ ...branch, customerCount: 145, mrr: 41_000_000 }],
      total: 1,
    });
    const result = await service.list({ limit: 50, offset: 0 });
    expect(result.items[0]?.customerCount).toBe(145);
    expect(result.items[0]?.mrr).toBe(41_000_000);
    expect(result.items[0]?.isHeadOffice).toBe(false);
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
