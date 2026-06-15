import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lead } from '../../infrastructure/database/schema/leads.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { PlansRepository } from '../plans/plans.repository';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import { LeadsRepository } from './leads.repository';
import { LeadsService } from './leads.service';

const baseLead: Lead = {
  id: '00000000-0000-0000-0000-00000000aa01',
  name: 'Citra Lestari',
  phone: '081200000000',
  address: 'Jl. Melati 3',
  areaName: 'Jepara',
  planName: 'Home 20',
  stage: 'survey',
  estValue: 200_000,
  source: 'online',
  note: null,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('LeadsService', () => {
  let service: LeadsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: { create: ReturnType<typeof vi.fn> };
  let workOrders: { scheduleInstall: ReturnType<typeof vi.fn> };
  let plans: { findByName: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      setStage: vi.fn(),
    };
    customers = { create: vi.fn() };
    workOrders = { scheduleInstall: vi.fn() };
    plans = { findByName: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        LeadsService,
        { provide: LeadsRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
        { provide: WorkOrdersService, useValue: workOrders },
        { provide: PlansRepository, useValue: plans },
      ],
    }).compile();
    service = moduleRef.get(LeadsService);
  });

  it('creates a lead and normalises a missing note to null', async () => {
    repo.create.mockResolvedValue(baseLead);
    await service.create({
      name: 'Citra Lestari',
      phone: '081200000000',
      address: 'Jl. Melati 3',
      areaName: 'Jepara',
      planName: 'Home 20',
      estValue: 200_000,
      source: 'online',
    });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ note: null }));
  });

  it('updates the stage', async () => {
    repo.setStage.mockResolvedValue({ ...baseLead, stage: 'quote' });
    const result = await service.updateStage(baseLead.id, { stage: 'quote' });
    expect(repo.setStage).toHaveBeenCalledWith(baseLead.id, 'quote');
    expect(result.stage).toBe('quote');
  });

  describe('convert', () => {
    it('creates a subscriber + install and marks the lead won', async () => {
      repo.findById.mockResolvedValue(baseLead);
      plans.findByName.mockResolvedValue({ id: 'plan-1', name: 'Home 20' });
      customers.create.mockResolvedValue({ id: 'cust-1' });
      workOrders.scheduleInstall.mockResolvedValue({ code: 'WO-9001' });
      repo.setStage.mockResolvedValue({ ...baseLead, stage: 'won' });

      const result = await service.convert(baseLead.id);

      expect(plans.findByName).toHaveBeenCalledWith('Home 20');
      expect(customers.create).toHaveBeenCalledWith(
        expect.objectContaining({
          fullName: 'Citra Lestari',
          planId: 'plan-1',
          status: 'instalasi',
        }),
      );
      expect(workOrders.scheduleInstall).toHaveBeenCalledWith('Citra Lestari');
      expect(repo.setStage).toHaveBeenCalledWith(baseLead.id, 'won');
      expect(result.stage).toBe('won');
    });

    it('is a no-op for an already-won lead', async () => {
      repo.findById.mockResolvedValue({ ...baseLead, stage: 'won' });
      const result = await service.convert(baseLead.id);
      expect(customers.create).not.toHaveBeenCalled();
      expect(workOrders.scheduleInstall).not.toHaveBeenCalled();
      expect(repo.setStage).not.toHaveBeenCalled();
      expect(result.stage).toBe('won');
    });

    it('rejects when the plan name does not resolve', async () => {
      repo.findById.mockResolvedValue(baseLead);
      plans.findByName.mockResolvedValue(null);
      await expect(service.convert(baseLead.id)).rejects.toBeInstanceOf(BadRequestException);
      expect(customers.create).not.toHaveBeenCalled();
    });

    it('throws 404 for a missing lead', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.convert('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
