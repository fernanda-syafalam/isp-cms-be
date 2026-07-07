import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from '../../infrastructure/database/schema/plans.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { PlansRepository } from './plans.repository';
import { PlansService } from './plans.service';

const planHome20: Plan = {
  id: '00000000-0000-0000-0000-0000000000a1',
  name: 'Home 20',
  speedMbps: 20,
  priceMonthly: 200_000,
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const planHome50: Plan = {
  id: '00000000-0000-0000-0000-0000000000a2',
  name: 'Home 50',
  speedMbps: 50,
  priceMonthly: 350_000,
  status: 'active',
  createdAt: new Date('2026-01-02T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};

const planBizArchived: Plan = {
  id: '00000000-0000-0000-0000-0000000000a3',
  name: 'Biz 100',
  speedMbps: 100,
  priceMonthly: 800_000,
  status: 'archived',
  createdAt: new Date('2025-06-01T00:00:00Z'),
  updatedAt: new Date('2025-06-01T00:00:00Z'),
};

describe('PlansService', () => {
  let service: PlansService;
  let repo: {
    list: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    archive: ReturnType<typeof vi.fn>;
  };
  let customers: { countByStatus: ReturnType<typeof vi.fn> };

  const statusCountsDefault = {
    prospek: 0,
    instalasi: 0,
    aktif: 0,
    isolir: 0,
    berhenti: 0,
  };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
    };
    customers = { countByStatus: vi.fn().mockResolvedValue(statusCountsDefault) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PlansService,
        { provide: PlansRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
      ],
    }).compile();
    service = moduleRef.get(PlansService);
  });

  // ── list / pagination / search / sort ─────────────────────────────────────

  const summary = { total: 2, byStatus: { active: 2, archived: 0 } };

  it('list returns items and filtered total from repository', async () => {
    repo.list.mockResolvedValue({ items: [planHome20, planHome50], total: 2, summary });
    const result = await service.list({ limit: 50, offset: 0 });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('list enriches the summary with totalSubscribers from the active customer count', async () => {
    repo.list.mockResolvedValue({ items: [planHome20, planHome50], total: 2, summary });
    customers.countByStatus.mockResolvedValue({ ...statusCountsDefault, aktif: 42 });
    const result = await service.list({ limit: 50, offset: 0 });
    expect(result.summary).toEqual({ ...summary, totalSubscribers: 42 });
  });

  it('list summary is independent of the q filter (full-set rollup)', async () => {
    repo.list.mockResolvedValue({ items: [planHome20], total: 1, summary });
    customers.countByStatus.mockResolvedValue({ ...statusCountsDefault, aktif: 10 });
    const result = await service.list({ q: 'Home', limit: 50, offset: 0 });
    expect(result.total).toBe(1); // filtered total, unaffected by summary
    expect(result.summary).toEqual({ ...summary, totalSubscribers: 10 });
  });

  it('list forwards q to the repository for name substring search', async () => {
    repo.list.mockResolvedValue({ items: [planHome20, planHome50], total: 2 });
    await service.list({ q: 'Home', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({ q: 'Home', limit: 50, offset: 0 });
  });

  it('list forwards sort by name asc to the repository', async () => {
    repo.list.mockResolvedValue({ items: [planHome20, planHome50], total: 2 });
    await service.list({ sort: 'name', order: 'asc', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({
      sort: 'name',
      order: 'asc',
      limit: 50,
      offset: 0,
    });
  });

  it('list forwards sort by name desc to the repository', async () => {
    repo.list.mockResolvedValue({ items: [planHome50, planHome20], total: 2 });
    await service.list({ sort: 'name', order: 'desc', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({
      sort: 'name',
      order: 'desc',
      limit: 50,
      offset: 0,
    });
  });

  it('list forwards sort by priceMonthly to the repository', async () => {
    repo.list.mockResolvedValue({ items: [planHome20, planHome50], total: 2 });
    await service.list({ sort: 'priceMonthly', order: 'asc', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({
      sort: 'priceMonthly',
      order: 'asc',
      limit: 50,
      offset: 0,
    });
  });

  it('list forwards sort by speedMbps to the repository', async () => {
    repo.list.mockResolvedValue({ items: [planHome20, planHome50, planBizArchived], total: 3 });
    await service.list({ sort: 'speedMbps', order: 'asc', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({
      sort: 'speedMbps',
      order: 'asc',
      limit: 50,
      offset: 0,
    });
  });

  it('list forwards an unknown sort key to the repository (fallback handled in repo)', async () => {
    repo.list.mockResolvedValue({ items: [planHome20], total: 1 });
    await service.list({ sort: 'subscriberCount', limit: 50, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({
      sort: 'subscriberCount',
      limit: 50,
      offset: 0,
    });
  });

  it('list reports the full filtered total independent of page size', async () => {
    // Simulate a page of 1 but total of 3 matching items.
    repo.list.mockResolvedValue({ items: [planHome20], total: 3 });
    const result = await service.list({ q: 'Home', limit: 1, offset: 0 });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(3);
  });

  // ── create / update / archive ─────────────────────────────────────────────

  it('creates a plan', async () => {
    repo.create.mockResolvedValue(planHome20);
    const created = await service.create({
      name: 'Home 20',
      speedMbps: 20,
      priceMonthly: 200_000,
    });
    expect(created).toEqual(planHome20);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('updates a plan', async () => {
    const updated = { ...planHome20, priceMonthly: 250_000 };
    repo.update.mockResolvedValue(updated);
    await expect(service.update(planHome20.id, { priceMonthly: 250_000 })).resolves.toEqual(
      updated,
    );
    expect(repo.update).toHaveBeenCalledWith(planHome20.id, {
      priceMonthly: 250_000,
    });
  });

  it('archives a plan', async () => {
    repo.archive.mockResolvedValue({ ...planHome20, status: 'archived' });
    const archived = await service.archive(planHome20.id);
    expect(archived.status).toBe('archived');
  });

  it('propagates 404 from the repository on update of a missing plan', async () => {
    repo.update.mockRejectedValue(new NotFoundException('plan not found'));
    await expect(service.update('missing', { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
