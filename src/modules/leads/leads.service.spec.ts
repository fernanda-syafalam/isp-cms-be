import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lead } from '../../infrastructure/database/schema/leads.schema';
import { OnboardingService } from '../onboarding/onboarding.service';
import { PlansRepository } from '../plans/plans.repository';
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
  resellerId: null,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('LeadsService', () => {
  let service: LeadsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let onboarding: { onboardFromLead: ReturnType<typeof vi.fn> };
  let plans: { findByName: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      setStage: vi.fn(),
    };
    onboarding = { onboardFromLead: vi.fn() };
    plans = { findByName: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        LeadsService,
        { provide: LeadsRepository, useValue: repo },
        { provide: OnboardingService, useValue: onboarding },
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
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ note: null, resellerId: null }),
    );
  });

  it('threads a supplied resellerId through to the repository (P3.D.2)', async () => {
    const resellerId = '00000000-0000-0000-0000-0000000000a1';
    repo.create.mockResolvedValue({ ...baseLead, resellerId });
    await service.create({
      name: 'Citra Lestari',
      phone: '081200000000',
      address: 'Jl. Melati 3',
      areaName: 'Jepara',
      planName: 'Home 20',
      estValue: 200_000,
      source: 'reseller',
      resellerId,
    });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ resellerId }));
  });

  it('surfaces resellerId on the response shape (toLeadResponse)', async () => {
    const resellerId = '00000000-0000-0000-0000-0000000000a1';
    repo.create.mockResolvedValue({ ...baseLead, resellerId });
    const result = await service.create({
      name: 'Citra Lestari',
      phone: '081200000000',
      address: 'Jl. Melati 3',
      areaName: 'Jepara',
      planName: 'Home 20',
      estValue: 200_000,
      source: 'reseller',
      resellerId,
    });
    expect(result.resellerId).toBe(resellerId);
  });

  it('updates the stage', async () => {
    repo.setStage.mockResolvedValue({ ...baseLead, stage: 'quote' });
    const result = await service.updateStage(baseLead.id, { stage: 'quote' });
    expect(repo.setStage).toHaveBeenCalledWith(baseLead.id, 'quote');
    expect(result.stage).toBe('quote');
  });

  describe('convert', () => {
    it('routes conversion through the onboarding path and marks the lead won', async () => {
      repo.findById.mockResolvedValue(baseLead);
      plans.findByName.mockResolvedValue({ id: 'plan-1', name: 'Home 20' });
      onboarding.onboardFromLead.mockResolvedValue({ id: 'cust-1', fullName: 'Citra Lestari' });
      repo.setStage.mockResolvedValue({ ...baseLead, stage: 'won' });

      const result = await service.convert(baseLead.id);

      expect(plans.findByName).toHaveBeenCalledWith('Home 20');
      // Single acquisition path (P3.A.2): onboarding creates the subscriber +
      // login + linked install WO (ADR-0009), not a bespoke leads path.
      expect(onboarding.onboardFromLead).toHaveBeenCalledWith({
        fullName: 'Citra Lestari',
        phone: baseLead.phone,
        address: baseLead.address,
        areaName: baseLead.areaName,
        planId: 'plan-1',
        resellerId: null,
      });
      expect(repo.setStage).toHaveBeenCalledWith(baseLead.id, 'won');
      expect(result.stage).toBe('won');
    });

    it('propagates the lead resellerId into onboarding (P3.D.2)', async () => {
      const resellerId = '00000000-0000-0000-0000-0000000000a1';
      repo.findById.mockResolvedValue({ ...baseLead, resellerId });
      plans.findByName.mockResolvedValue({ id: 'plan-1', name: 'Home 20' });
      onboarding.onboardFromLead.mockResolvedValue({ id: 'cust-1', fullName: 'Citra Lestari' });
      repo.setStage.mockResolvedValue({ ...baseLead, stage: 'won', resellerId });

      await service.convert(baseLead.id);

      expect(onboarding.onboardFromLead).toHaveBeenCalledWith(
        expect.objectContaining({ resellerId }),
      );
    });

    it('is a no-op for an already-won lead', async () => {
      repo.findById.mockResolvedValue({ ...baseLead, stage: 'won' });
      const result = await service.convert(baseLead.id);
      expect(onboarding.onboardFromLead).not.toHaveBeenCalled();
      expect(repo.setStage).not.toHaveBeenCalled();
      expect(result.stage).toBe('won');
    });

    it('rejects when the plan name does not resolve', async () => {
      repo.findById.mockResolvedValue(baseLead);
      plans.findByName.mockResolvedValue(null);
      await expect(service.convert(baseLead.id)).rejects.toBeInstanceOf(BadRequestException);
      expect(onboarding.onboardFromLead).not.toHaveBeenCalled();
    });

    it('throws 404 for a missing lead', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.convert('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
