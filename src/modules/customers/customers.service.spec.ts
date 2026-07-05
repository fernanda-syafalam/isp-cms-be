import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationsService } from '../notifications/notifications.service';
import { PlansRepository } from '../plans/plans.repository';
import { SecretEnforcementService } from '../router-resources/secret-enforcement.service';
import { type CustomerRow, CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';

const PLAN_ID = '00000000-0000-0000-0000-0000000000b1';

const sampleRow: CustomerRow = {
  id: '00000000-0000-0000-0000-0000000000c1',
  customerNo: 'CUST-9001',
  fullName: 'Budi Santoso',
  phone: '081234567890',
  email: null,
  userId: null,
  address: 'Jl. Mawar 1',
  areaId: null,
  areaName: null,
  planId: PLAN_ID,
  status: 'prospek',
  holdReason: null,
  outstanding: 0,
  npwp: null,
  ktp: null,
  consentAt: null,
  dataDeletionRequestedAt: null,
  resellerName: null,
  resellerId: null,
  connection: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  planName: 'Home 20',
};

describe('CustomersService', () => {
  let service: CustomersService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let plans: { findById: ReturnType<typeof vi.fn> };
  let notifications: { send: ReturnType<typeof vi.fn> };
  let secrets: { applyDisabledForCustomer: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      findByEmail: vi.fn(),
      findByUserId: vi.fn(),
      create: vi.fn(),
      updateProfile: vi.fn(),
      setStatus: vi.fn(),
      recordConsent: vi.fn(),
      updateKyc: vi.fn(),
      requestDataDeletion: vi.fn(),
      relocate: vi.fn(),
      setBilling: vi.fn(),
    };
    plans = { findById: vi.fn() };
    notifications = { send: vi.fn() };
    secrets = { applyDisabledForCustomer: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: CustomersRepository, useValue: repo },
        { provide: PlansRepository, useValue: plans },
        { provide: NotificationsService, useValue: notifications },
        { provide: SecretEnforcementService, useValue: secrets },
      ],
    }).compile();
    service = moduleRef.get(CustomersService);
  });

  describe('list scoping (P1.5)', () => {
    const mitra = {
      id: 'u-1',
      email: 'mitra@example.com',
      fullName: 'Mira Mitra',
      role: 'mitra' as const,
      resellerId: '00000000-0000-0000-0000-0000000000r1',
    };

    it('forces the mitra reseller scope over any client filter', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0 });

      await service.list({ resellerId: 'someone-else', limit: 50, offset: 0 }, mitra);

      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ resellerId: mitra.resellerId }),
      );
    });

    it('returns empty for a mitra with no linked reseller', async () => {
      const result = await service.list({ limit: 50, offset: 0 }, { ...mitra, resellerId: null });

      expect(result).toEqual({ items: [], total: 0 });
      expect(repo.list).not.toHaveBeenCalled();
    });

    it('leaves staff reads unscoped', async () => {
      repo.list.mockResolvedValue({ items: [sampleRow], total: 1 });

      await service.list({ limit: 50, offset: 0 }, { ...mitra, role: 'staff' });

      expect(repo.list).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    });
  });

  describe('resolveForPortal', () => {
    const session = { id: '00000000-0000-0000-0000-0000000000u1', email: 'budi@example.com' };

    it('resolves by the linked user id first (P1.3)', async () => {
      repo.findByUserId.mockResolvedValue({ ...sampleRow, userId: session.id });

      const result = await service.resolveForPortal(session);

      expect(repo.findByUserId).toHaveBeenCalledWith(session.id);
      expect(repo.findByEmail).not.toHaveBeenCalled();
      expect(result.id).toBe(sampleRow.id);
    });

    it('falls back to the session email for unlinked legacy subscribers', async () => {
      repo.findByUserId.mockResolvedValue(null);
      repo.findByEmail.mockResolvedValue({ ...sampleRow, email: session.email });

      const result = await service.resolveForPortal(session);

      expect(repo.findByEmail).toHaveBeenCalledWith(session.email);
      expect(result.email).toBe(session.email);
    });

    it('fails closed (404) when neither the link nor the email matches', async () => {
      repo.findByUserId.mockResolvedValue(null);
      repo.findByEmail.mockResolvedValue(null);

      await expect(service.resolveForPortal(session)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('fails closed (404) when the session has no email and no link', async () => {
      repo.findByUserId.mockResolvedValue(null);

      await expect(
        service.resolveForPortal({ id: session.id, email: null }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.findByEmail).not.toHaveBeenCalled();
    });
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

  describe('onboard', () => {
    it('opens the customer in instalasi with the chosen area', async () => {
      plans.findById.mockResolvedValue({ id: PLAN_ID, name: 'Home 20' });
      repo.create.mockResolvedValue({ ...sampleRow, status: 'instalasi', areaName: 'Bangsri' });

      const result = await service.onboard({
        fullName: 'Budi Santoso',
        phone: '081234567890',
        email: '',
        address: 'Jl. Mawar 1',
        areaName: 'Bangsri',
        planId: PLAN_ID,
      });

      expect(plans.findById).toHaveBeenCalledWith(PLAN_ID);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          areaName: 'Bangsri',
          status: 'instalasi',
          email: null,
          planId: PLAN_ID,
        }),
      );
      expect(result.status).toBe('instalasi');
      expect(result.areaName).toBe('Bangsri');
    });

    it('rejects an unknown plan with 400 before creating', async () => {
      plans.findById.mockResolvedValue(null);
      await expect(
        service.onboard({
          fullName: 'X',
          phone: '081200000000',
          email: '',
          address: 'Jl. Y',
          areaName: 'Bangsri',
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
    it('distinguishes voluntary suspend (cuti) from punitive isolate (P3.A.3)', async () => {
      repo.setStatus.mockResolvedValue({ ...sampleRow, status: 'isolir' });
      await service.suspend(sampleRow.id);
      expect(repo.setStatus).toHaveBeenCalledWith(sampleRow.id, 'isolir', {
        holdReason: 'voluntary',
      });
      await service.isolate(sampleRow.id);
      expect(repo.setStatus).toHaveBeenLastCalledWith(sampleRow.id, 'isolir', {
        holdReason: 'overdue',
      });
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

    // ADR-0008: the PPPoE secret follows the lifecycle — non-active states cut
    // the session, `aktif` restores it.
    it('disables the PPPoE secret on every non-active transition', async () => {
      for (const status of ['isolir', 'berhenti'] as const) {
        secrets.applyDisabledForCustomer.mockClear();
        repo.setStatus.mockResolvedValue({ ...sampleRow, status });
        await (status === 'isolir' ? service.isolate(sampleRow.id) : service.stop(sampleRow.id));
        expect(secrets.applyDisabledForCustomer).toHaveBeenCalledWith(sampleRow.id, true);
      }
    });

    it('re-enables the PPPoE secret when the customer goes active', async () => {
      repo.setStatus.mockResolvedValue({ ...sampleRow, status: 'aktif', outstanding: 0 });
      await service.activate(sampleRow.id);
      expect(secrets.applyDisabledForCustomer).toHaveBeenCalledWith(sampleRow.id, false);
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

  describe('list', () => {
    it('projects every row and passes the total through', async () => {
      repo.list.mockResolvedValue({ items: [sampleRow], total: 1 });
      const result = await service.list({ limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.planName).toBe('Home 20');
    });

    it('forwards q search to the repository', async () => {
      repo.list.mockResolvedValue({ items: [sampleRow], total: 1 });
      await service.list({ q: '0812', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ q: '0812' }));
    });

    it('forwards sort + order to the repository', async () => {
      repo.list.mockResolvedValue({ items: [sampleRow], total: 1 });
      await service.list({ sort: 'joinedAt', order: 'desc', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'joinedAt', order: 'desc' }),
      );
    });

    it('forwards multi-value area filter to the repository', async () => {
      repo.list.mockResolvedValue({ items: [sampleRow], total: 1 });
      await service.list({ area: ['Jepara', 'Tahunan'], limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ area: ['Jepara', 'Tahunan'] }),
      );
    });

    it('passes area: undefined when no area filter is given', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0 });
      await service.list({ limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(
        expect.not.objectContaining({ area: expect.anything() }),
      );
    });
  });

  describe('subscriber actions', () => {
    it('relocate updates address + area', async () => {
      repo.relocate.mockResolvedValue({ ...sampleRow, address: 'Jl. Baru 9', areaName: 'Bangsri' });
      const result = await service.relocate(sampleRow.id, {
        address: 'Jl. Baru 9',
        areaName: 'Bangsri',
      });
      expect(repo.relocate).toHaveBeenCalledWith(sampleRow.id, {
        address: 'Jl. Baru 9',
        areaName: 'Bangsri',
      });
      expect(result.areaName).toBe('Bangsri');
    });

    it('onu reboot / wifi are acknowledgments that 404 on a missing customer', async () => {
      repo.findById.mockResolvedValue(sampleRow);
      await expect(service.rebootOnu(sampleRow.id)).resolves.toMatchObject({ id: sampleRow.id });
      await expect(
        service.setOnuWifi(sampleRow.id, { ssid: 'Net', password: 'supersecret' }),
      ).resolves.toMatchObject({ id: sampleRow.id });
      repo.findById.mockResolvedValue(null);
      await expect(service.rebootOnu('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('notifyWhatsapp sends a due_soon reminder to the customer phone', async () => {
      repo.findById.mockResolvedValue(sampleRow);
      await service.notifyWhatsapp(sampleRow.id);
      expect(notifications.send).toHaveBeenCalledWith({ event: 'due_soon', to: sampleRow.phone });
    });

    describe('changePlan', () => {
      it('adds the price delta to outstanding on an upgrade', async () => {
        repo.findById.mockResolvedValue({ ...sampleRow, outstanding: 0, planId: PLAN_ID });
        plans.findById.mockImplementation((id: string) =>
          Promise.resolve(
            id === 'plan-new'
              ? { id: 'plan-new', name: 'Pro 100', priceMonthly: 500_000 }
              : { id: PLAN_ID, name: 'Home 20', priceMonthly: 200_000 },
          ),
        );
        repo.updateProfile.mockResolvedValue(sampleRow);
        repo.setBilling.mockResolvedValue(undefined);

        await service.changePlan(sampleRow.id, { planId: 'plan-new' });

        expect(repo.updateProfile).toHaveBeenCalledWith(sampleRow.id, { planId: 'plan-new' });
        // delta 300k added to outstanding
        expect(repo.setBilling).toHaveBeenCalledWith(sampleRow.id, { outstanding: 300_000 });
      });

      it('does not touch outstanding on a downgrade', async () => {
        repo.findById.mockResolvedValue({ ...sampleRow, outstanding: 0 });
        plans.findById.mockImplementation((id: string) =>
          Promise.resolve(
            id === 'plan-cheap'
              ? { id: 'plan-cheap', name: 'Home 10', priceMonthly: 100_000 }
              : { id: PLAN_ID, name: 'Home 20', priceMonthly: 200_000 },
          ),
        );
        repo.updateProfile.mockResolvedValue(sampleRow);
        await service.changePlan(sampleRow.id, { planId: 'plan-cheap' });
        expect(repo.setBilling).not.toHaveBeenCalled();
      });

      it('rejects an unknown plan with 400', async () => {
        repo.findById.mockResolvedValue(sampleRow);
        plans.findById.mockResolvedValue(null);
        await expect(service.changePlan(sampleRow.id, { planId: 'nope' })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
    });
  });
});
