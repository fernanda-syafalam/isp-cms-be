import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from '../../infrastructure/database/schema/plans.schema';
import { PlansRepository } from './plans.repository';
import { PlansService } from './plans.service';

const samplePlan: Plan = {
  id: '00000000-0000-0000-0000-0000000000a1',
  name: 'Home 20',
  speedMbps: 20,
  priceMonthly: 200_000,
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('PlansService', () => {
  let service: PlansService;
  let repo: {
    findAll: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    archive: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    repo = {
      findAll: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [PlansService, { provide: PlansRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(PlansService);
  });

  it('lists plans', async () => {
    repo.findAll.mockResolvedValue([samplePlan]);
    await expect(service.list()).resolves.toEqual([samplePlan]);
  });

  it('creates a plan', async () => {
    repo.create.mockResolvedValue(samplePlan);
    const created = await service.create({
      name: 'Home 20',
      speedMbps: 20,
      priceMonthly: 200_000,
    });
    expect(created).toEqual(samplePlan);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('updates a plan', async () => {
    const updated = { ...samplePlan, priceMonthly: 250_000 };
    repo.update.mockResolvedValue(updated);
    await expect(service.update(samplePlan.id, { priceMonthly: 250_000 })).resolves.toEqual(
      updated,
    );
    expect(repo.update).toHaveBeenCalledWith(samplePlan.id, {
      priceMonthly: 250_000,
    });
  });

  it('archives a plan', async () => {
    repo.archive.mockResolvedValue({ ...samplePlan, status: 'archived' });
    const archived = await service.archive(samplePlan.id);
    expect(archived.status).toBe('archived');
  });

  it('propagates 404 from the repository on update of a missing plan', async () => {
    repo.update.mockRejectedValue(new NotFoundException('plan not found'));
    await expect(service.update('missing', { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
