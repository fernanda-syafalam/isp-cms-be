import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlansRepository } from '../plans/plans.repository';
import { type CustomerRow, CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';

const PLAN_ID = '00000000-0000-0000-0000-0000000000b1';

const sampleRow: CustomerRow = {
  id: '00000000-0000-0000-0000-0000000000c1',
  customerNo: 'CUST-9001',
  fullName: 'Budi Santoso',
  phone: '081234567890',
  email: null,
  address: 'Jl. Mawar 1',
  areaId: null,
  areaName: null,
  planId: PLAN_ID,
  status: 'prospek',
  outstanding: 0,
  npwp: null,
  ktp: null,
  consentAt: null,
  dataDeletionRequestedAt: null,
  resellerName: null,
  connection: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  planName: 'Home 20',
};

describe('CustomersService', () => {
  let service: CustomersService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let plans: { findById: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      updateProfile: vi.fn(),
      setStatus: vi.fn(),
      recordConsent: vi.fn(),
      updateKyc: vi.fn(),
      requestDataDeletion: vi.fn(),
    };
    plans = { findById: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: CustomersRepository, useValue: repo },
        { provide: PlansRepository, useValue: plans },
      ],
    }).compile();
    service = moduleRef.get(CustomersService);
  });

  describe('create', () => {
    it('validates the plan FK and normalises empty email to null', async () => {
      plans.findById.mockResolvedValue({ id: PLAN_ID, name: 'Home 20' });
      repo.create.mockResolvedValue(sampleRow);

      const result = await service.create({
        fullName: 'Budi Santoso',
        phone: '081234567890',
        email: '',
        address: 'Jl. Mawar 1',
        planId: PLAN_ID,
      });

      expect(plans.findById).toHaveBeenCalledWith(PLAN_ID);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: null, planId: PLAN_ID }),
      );
      // Response is projected: planName joined, joinedAt is an ISO string.
      expect(result.planName).toBe('Home 20');
      expect(result.joinedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(result.consentAt).toBeNull();
    });

    it('rejects an unknown plan with 400', async () => {
      plans.findById.mockResolvedValue(null);
      await expect(
        service.create({
          fullName: 'X',
          phone: '081200000000',
          email: '',
          address: 'Jl. Y',
          planId: PLAN_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('passes only provided fields and validates plan when planId changes', async () => {
      plans.findById.mockResolvedValue({ id: PLAN_ID, name: 'Home 20' });
      repo.updateProfile.mockResolvedValue(sampleRow);

      await service.update(sampleRow.id, {
        phone: '080000000000',
        planId: PLAN_ID,
      });

      expect(plans.findById).toHaveBeenCalledWith(PLAN_ID);
      expect(repo.updateProfile).toHaveBeenCalledWith(sampleRow.id, {
        phone: '080000000000',
        planId: PLAN_ID,
      });
    });

    it('does not touch plans when planId is absent', async () => {
      repo.updateProfile.mockResolvedValue(sampleRow);
      await service.update(sampleRow.id, { fullName: 'Budi B' });
      expect(plans.findById).not.toHaveBeenCalled();
      expect(repo.updateProfile).toHaveBeenCalledWith(sampleRow.id, {
        fullName: 'Budi B',
      });
    });
  });

  describe('lifecycle', () => {
    it('suspend and isolate land on isolir without clearing the balance', async () => {
      repo.setStatus.mockResolvedValue({ ...sampleRow, status: 'isolir' });
      await service.suspend(sampleRow.id);
      expect(repo.setStatus).toHaveBeenCalledWith(sampleRow.id, 'isolir', {});
      await service.isolate(sampleRow.id);
      expect(repo.setStatus).toHaveBeenLastCalledWith(sampleRow.id, 'isolir', {});
    });

    it('activate clears the outstanding balance', async () => {
      repo.setStatus.mockResolvedValue({
        ...sampleRow,
        status: 'aktif',
        outstanding: 0,
      });
      await service.activate(sampleRow.id);
      expect(repo.setStatus).toHaveBeenCalledWith(sampleRow.id, 'aktif', {
        clearOutstanding: true,
      });
    });

    it('resume keeps the balance', async () => {
      repo.setStatus.mockResolvedValue({ ...sampleRow, status: 'aktif' });
      await service.resume(sampleRow.id);
      expect(repo.setStatus).toHaveBeenCalledWith(sampleRow.id, 'aktif', {});
    });

    it('stop churns the customer', async () => {
      repo.setStatus.mockResolvedValue({ ...sampleRow, status: 'berhenti' });
      const result = await service.stop(sampleRow.id);
      expect(repo.setStatus).toHaveBeenCalledWith(sampleRow.id, 'berhenti', {});
      expect(result.status).toBe('berhenti');
    });
  });

  describe('compliance', () => {
    it('updateKyc normalises empty npwp to null', async () => {
      repo.updateKyc.mockResolvedValue(sampleRow);
      await service.updateKyc(sampleRow.id, { ktp: '3201xxxx', npwp: '' });
      expect(repo.updateKyc).toHaveBeenCalledWith(sampleRow.id, {
        ktp: '3201xxxx',
        npwp: null,
      });
    });

    it('records consent and maps the timestamp to ISO', async () => {
      repo.recordConsent.mockResolvedValue({
        ...sampleRow,
        consentAt: new Date('2026-06-15T10:00:00.000Z'),
      });
      const result = await service.recordConsent(sampleRow.id);
      expect(result.consentAt).toBe('2026-06-15T10:00:00.000Z');
    });

    it('delegates data-deletion to the repository', async () => {
      repo.requestDataDeletion.mockResolvedValue(undefined);
      await service.requestDataDeletion(sampleRow.id);
      expect(repo.requestDataDeletion).toHaveBeenCalledWith(sampleRow.id);
    });
  });

  it('findById throws 404 when the customer is absent', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.findById('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list projects every row and passes the total through', async () => {
    repo.list.mockResolvedValue({ items: [sampleRow], total: 1 });
    const result = await service.list({ limit: 50, offset: 0 });
    expect(result.total).toBe(1);
    expect(result.items[0]?.planName).toBe('Home 20');
  });
});
