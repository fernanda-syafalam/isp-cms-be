import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationsService } from '../notifications/notifications.service';
import { PlansRepository } from '../plans/plans.repository';
import { ResellersRepository } from '../resellers/resellers.repository';
import { SecretEnforcementService } from '../router-resources/secret-enforcement.service';
import { SettingsService } from '../settings/settings.service';
import { type CustomerRow, CustomersRepository } from './customers.repository';
import { CustomersService, assertLegalCustomerTransition } from './customers.service';

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
  lat: null,
  lng: null,
  odpId: null,
  planId: PLAN_ID,
  status: 'prospek',
  holdReason: null,
  outstanding: 0,
  billingAnchorDay: null,
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
  let notifications: { send: ReturnType<typeof vi.fn>; enqueue: ReturnType<typeof vi.fn> };
  let secrets: { applyDisabledForCustomer: ReturnType<typeof vi.fn> };
  let resellers: { findById: ReturnType<typeof vi.fn> };
  let settings: { getBillingPolicy: ReturnType<typeof vi.fn> };

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
      applyProration: vi.fn(),
      changePlan: vi.fn(),
    };
    plans = { findById: vi.fn() };
    notifications = { send: vi.fn(), enqueue: vi.fn() };
    secrets = { applyDisabledForCustomer: vi.fn() };
    resellers = { findById: vi.fn() };
    settings = { getBillingPolicy: vi.fn().mockResolvedValue({ dueDays: 7 }) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: CustomersRepository, useValue: repo },
        { provide: PlansRepository, useValue: plans },
        { provide: NotificationsService, useValue: notifications },
        { provide: SecretEnforcementService, useValue: secrets },
        { provide: ResellersRepository, useValue: resellers },
        { provide: SettingsService, useValue: settings },
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

    // #25/#26 scope-escape guard: a mitra passing the ops
    // unassignedReseller diagnostic flag must not see reseller-less
    // customers — the forced own-resellerId scope must win.
    it('clears a client-supplied unassignedReseller flag for a mitra (no scope escape)', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0 });

      await service.list({ unassignedReseller: true, limit: 50, offset: 0 }, mitra);

      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ resellerId: mitra.resellerId, unassignedReseller: false }),
      );
    });

    it('returns empty (with a zero-filled summary) for a mitra with no linked reseller', async () => {
      const result = await service.list({ limit: 50, offset: 0 }, { ...mitra, resellerId: null });

      expect(result).toEqual({
        items: [],
        total: 0,
        summary: {
          total: 0,
          outstanding: 0,
          byStatus: { prospek: 0, instalasi: 0, aktif: 0, isolir: 0, berhenti: 0 },
        },
      });
      expect(repo.list).not.toHaveBeenCalled();
    });

    it('leaves staff reads unscoped', async () => {
      repo.list.mockResolvedValue({ items: [sampleRow], total: 1 });

      await service.list({ limit: 50, offset: 0 }, { ...mitra, role: 'staff' });

      expect(repo.list).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    });
  });

  // ADR-0010 amendment / ADR-0015 (SEC-4): a mitra reads the KYC-safe
  // projection — npwp/ktp omitted entirely, not merely null — on both the
  // list and the detail surface. Admin/staff (and internal callers with no
  // user) are unaffected.
  describe('KYC-safe projection for mitra (ADR-0010 amendment / ADR-0015, SEC-4)', () => {
    const mitra = {
      id: 'u-1',
      email: 'mitra@example.com',
      fullName: 'Mira Mitra',
      role: 'mitra' as const,
      resellerId: '00000000-0000-0000-0000-0000000000r1',
    };
    const kycRow: CustomerRow = {
      ...sampleRow,
      resellerId: mitra.resellerId,
      npwp: '01.234.567.8-901.000',
      ktp: '3201xxxxxxxxxxxx',
    };

    describe('list', () => {
      it('tells the repository to exclude KYC columns for a mitra', async () => {
        repo.list.mockResolvedValue({ items: [], total: 0 });
        await service.list({ limit: 50, offset: 0 }, mitra);
        expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ excludeKyc: true }));
      });

      it('omits npwp/ktp keys entirely from a mitra list response', async () => {
        repo.list.mockResolvedValue({ items: [kycRow], total: 1 });
        const result = await service.list({ limit: 50, offset: 0 }, mitra);
        expect(result.items[0]).not.toHaveProperty('npwp');
        expect(result.items[0]).not.toHaveProperty('ktp');
      });

      // ADR-0011 parity: billingAnchorDay is billing config, not KYC — it
      // must survive the mitra projection unlike npwp/ktp above.
      it('includes billingAnchorDay in a mitra list response (not gated by the KYC projection)', async () => {
        repo.list.mockResolvedValue({
          items: [{ ...kycRow, billingAnchorDay: 15 }],
          total: 1,
        });
        const result = await service.list({ limit: 50, offset: 0 }, mitra);
        expect(result.items[0]?.billingAnchorDay).toBe(15);
      });

      it('does not set excludeKyc for staff/admin reads', async () => {
        repo.list.mockResolvedValue({ items: [], total: 0 });
        await service.list({ limit: 50, offset: 0 }, { ...mitra, role: 'staff' });
        expect(repo.list).toHaveBeenCalledWith(
          expect.not.objectContaining({ excludeKyc: expect.anything() }),
        );
      });

      it('staff still receive npwp/ktp in the list response', async () => {
        repo.list.mockResolvedValue({ items: [kycRow], total: 1 });
        const result = await service.list({ limit: 50, offset: 0 }, { ...mitra, role: 'staff' });
        expect(result.items[0]?.npwp).toBe(kycRow.npwp);
        expect(result.items[0]?.ktp).toBe(kycRow.ktp);
      });
    });

    describe('findById', () => {
      it('asks the repository to exclude KYC columns for a mitra', async () => {
        repo.findById.mockResolvedValue(kycRow);
        await service.findById(kycRow.id, mitra);
        expect(repo.findById).toHaveBeenCalledWith(kycRow.id, { excludeKyc: true });
      });

      it('omits npwp/ktp keys entirely from a mitra detail response', async () => {
        repo.findById.mockResolvedValue(kycRow);
        const result = await service.findById(kycRow.id, mitra);
        expect(result).not.toHaveProperty('npwp');
        expect(result).not.toHaveProperty('ktp');
      });

      it('admin/staff (and no-user internal callers) still get npwp/ktp', async () => {
        repo.findById.mockResolvedValue(kycRow);
        const asStaff = await service.findById(kycRow.id, { ...mitra, role: 'staff' });
        expect(asStaff.npwp).toBe(kycRow.npwp);
        expect(asStaff.ktp).toBe(kycRow.ktp);

        const noUser = await service.findById(kycRow.id);
        expect(noUser.npwp).toBe(kycRow.npwp);
        expect(noUser.ktp).toBe(kycRow.ktp);
        expect(repo.findById).toHaveBeenLastCalledWith(kycRow.id, { excludeKyc: false });
      });

      it('a mitra cannot read another reseller customer by id (scoping regression guard, 404)', async () => {
        repo.findById.mockResolvedValue({ ...kycRow, resellerId: 'someone-elses-reseller' });
        await expect(service.findById(kycRow.id, mitra)).rejects.toBeInstanceOf(NotFoundException);
      });

      it('a mitra with no linked reseller cannot read any customer by id (404)', async () => {
        repo.findById.mockResolvedValue({ ...kycRow, resellerId: null });
        await expect(
          service.findById(kycRow.id, { ...mitra, resellerId: null }),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('a mitra CAN read their own reseller customer by id', async () => {
        repo.findById.mockResolvedValue(kycRow);
        await expect(service.findById(kycRow.id, mitra)).resolves.toMatchObject({ id: kycRow.id });
      });

      // ADR-0011 parity: billingAnchorDay is billing config, not KYC — must
      // survive both the mitra projection and the null (unset) case.
      it('includes billingAnchorDay in the detail response for a mitra, null when unset', async () => {
        repo.findById.mockResolvedValue({ ...kycRow, billingAnchorDay: 10 });
        const result = await service.findById(kycRow.id, mitra);
        expect(result.billingAnchorDay).toBe(10);

        repo.findById.mockResolvedValue({ ...kycRow, billingAnchorDay: null });
        const unset = await service.findById(kycRow.id, mitra);
        expect(unset.billingAnchorDay).toBeNull();
      });
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

    it('threads a resellerId that exists into repo.create (P3.D.2)', async () => {
      const resellerId = '00000000-0000-0000-0000-0000000000a1';
      plans.findById.mockResolvedValue({ id: PLAN_ID, name: 'Home 20' });
      resellers.findById.mockResolvedValue({ id: resellerId, name: 'Mitra A' });
      repo.create.mockResolvedValue({ ...sampleRow, status: 'instalasi', resellerId });

      await service.onboard({
        fullName: 'Budi Santoso',
        phone: '081234567890',
        email: '',
        address: 'Jl. Mawar 1',
        areaName: 'Bangsri',
        planId: PLAN_ID,
        resellerId,
      });

      expect(resellers.findById).toHaveBeenCalledWith(resellerId);
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ resellerId }));
    });

    it('rejects an unknown resellerId with 400 before creating (P3.D.2)', async () => {
      plans.findById.mockResolvedValue({ id: PLAN_ID, name: 'Home 20' });
      resellers.findById.mockResolvedValue(null);

      await expect(
        service.onboard({
          fullName: 'Budi Santoso',
          phone: '081234567890',
          email: '',
          address: 'Jl. Mawar 1',
          areaName: 'Bangsri',
          planId: PLAN_ID,
          resellerId: 'missing-reseller',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('skips the reseller check when resellerId is absent', async () => {
      plans.findById.mockResolvedValue({ id: PLAN_ID, name: 'Home 20' });
      repo.create.mockResolvedValue({ ...sampleRow, status: 'instalasi' });

      await service.onboard({
        fullName: 'Budi Santoso',
        phone: '081234567890',
        email: '',
        address: 'Jl. Mawar 1',
        areaName: 'Bangsri',
        planId: PLAN_ID,
      });

      expect(resellers.findById).not.toHaveBeenCalled();
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
      // Both land on isolir from aktif — the only ADR-0004-legal manual
      // entry into isolir (suspend()/isolate() rows).
      repo.findById.mockResolvedValue({ ...sampleRow, status: 'aktif' });
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
      repo.findById.mockResolvedValue({ ...sampleRow, status: 'isolir' });
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
      repo.findById.mockResolvedValue({ ...sampleRow, status: 'isolir' });
      repo.setStatus.mockResolvedValue({ ...sampleRow, status: 'aktif' });
      await service.resume(sampleRow.id);
      expect(repo.setStatus).toHaveBeenCalledWith(sampleRow.id, 'aktif', {});
    });

    it('stop churns the customer', async () => {
      repo.findById.mockResolvedValue({ ...sampleRow, status: 'aktif' });
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
        // Both isolate() and stop() are legal from aktif.
        repo.findById.mockResolvedValue({ ...sampleRow, status: 'aktif' });
        repo.setStatus.mockResolvedValue({ ...sampleRow, status });
        await (status === 'isolir' ? service.isolate(sampleRow.id) : service.stop(sampleRow.id));
        expect(secrets.applyDisabledForCustomer).toHaveBeenCalledWith(sampleRow.id, true);
      }
    });

    it('re-enables the PPPoE secret when the customer goes active', async () => {
      repo.findById.mockResolvedValue({ ...sampleRow, status: 'isolir' });
      repo.setStatus.mockResolvedValue({ ...sampleRow, status: 'aktif', outstanding: 0 });
      await service.activate(sampleRow.id);
      expect(secrets.applyDisabledForCustomer).toHaveBeenCalledWith(sampleRow.id, false);
    });
  });

  // D6/NL-2 (go-live defect, ADR-0004): transition() must reject any
  // from -> to pair not in the locked graph, and must do so BEFORE any DB
  // write or network side effect.
  describe('lifecycle guard (D6/NL-2, ADR-0004)', () => {
    it('rejects berhenti -> aktif (activate on a churned customer) with 400, no write, no side effect', async () => {
      repo.findById.mockResolvedValue({ ...sampleRow, status: 'berhenti' });

      await expect(service.activate(sampleRow.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(repo.setStatus).not.toHaveBeenCalled();
      expect(secrets.applyDisabledForCustomer).not.toHaveBeenCalled();
    });

    it('rejects berhenti -> isolir with 400 (berhenti is terminal)', async () => {
      repo.findById.mockResolvedValue({ ...sampleRow, status: 'berhenti' });

      await expect(service.isolate(sampleRow.id)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.setStatus).not.toHaveBeenCalled();
    });

    it('rejects prospek -> aktif (activate before install/provisioning) with 400', async () => {
      repo.findById.mockResolvedValue({ ...sampleRow, status: 'prospek' });

      await expect(service.activate(sampleRow.id)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.setStatus).not.toHaveBeenCalled();
      expect(secrets.applyDisabledForCustomer).not.toHaveBeenCalled();
    });

    it('rejects a same-state call (aktif -> aktif via resume) with 400', async () => {
      repo.findById.mockResolvedValue({ ...sampleRow, status: 'aktif' });

      await expect(service.resume(sampleRow.id)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.setStatus).not.toHaveBeenCalled();
    });

    it('allows isolir -> aktif (reactivation / pay-to-reconnect)', async () => {
      repo.findById.mockResolvedValue({ ...sampleRow, status: 'isolir' });
      repo.setStatus.mockResolvedValue({ ...sampleRow, status: 'aktif' });

      await expect(service.activate(sampleRow.id)).resolves.toMatchObject({ status: 'aktif' });
      expect(repo.setStatus).toHaveBeenCalledWith(sampleRow.id, 'aktif', {
        clearOutstanding: true,
      });
    });

    it('allows aktif -> isolir (isolate for non-payment)', async () => {
      repo.findById.mockResolvedValue({ ...sampleRow, status: 'aktif' });
      repo.setStatus.mockResolvedValue({ ...sampleRow, status: 'isolir' });

      await expect(service.isolate(sampleRow.id)).resolves.toMatchObject({ status: 'isolir' });
      expect(repo.setStatus).toHaveBeenCalledWith(sampleRow.id, 'isolir', {
        holdReason: 'overdue',
      });
    });

    // These two edges (prospek -> instalasi, instalasi -> aktif) are legal
    // per ADR-0004's locked graph but are reached via onboard()/markInstalled
    // — not via a transition() verb — so they are exercised directly against
    // the exported guard, keeping the table's full coverage testable.
    it('exposes prospek -> instalasi and instalasi -> aktif as legal in the guard table', () => {
      expect(() => assertLegalCustomerTransition('prospek', 'instalasi')).not.toThrow();
      expect(() => assertLegalCustomerTransition('instalasi', 'aktif')).not.toThrow();
    });

    it('rejects instalasi -> isolir and instalasi -> berhenti in the guard table', () => {
      expect(() => assertLegalCustomerTransition('instalasi', 'isolir')).toThrow(
        BadRequestException,
      );
      expect(() => assertLegalCustomerTransition('instalasi', 'berhenti')).toThrow(
        BadRequestException,
      );
    });

    it('error message names the illegal from/to pair', async () => {
      repo.findById.mockResolvedValue({ ...sampleRow, status: 'berhenti' });
      await expect(service.activate(sampleRow.id)).rejects.toThrow(
        'cannot transition from berhenti to aktif',
      );
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
    const summary = {
      total: 1,
      outstanding: 0,
      byStatus: { prospek: 0, instalasi: 0, aktif: 1, isolir: 0, berhenti: 0 },
    };

    it('projects every row and passes the total through', async () => {
      repo.list.mockResolvedValue({ items: [sampleRow], total: 1, summary });
      const result = await service.list({ limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.planName).toBe('Home 20');
    });

    it('passes the summary rollup through unchanged (FE contract parity)', async () => {
      repo.list.mockResolvedValue({ items: [sampleRow], total: 1, summary });
      const result = await service.list({ limit: 50, offset: 0 });
      expect(result.summary).toEqual(summary);
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

    it('notifyWhatsapp enqueues a due_soon reminder with real vars through the queue (not send() directly)', async () => {
      repo.findById.mockResolvedValue(sampleRow);
      await service.notifyWhatsapp(sampleRow.id);
      expect(notifications.send).not.toHaveBeenCalled();
      expect(notifications.enqueue).toHaveBeenCalledTimes(1);
      const [payload, jobId] = notifications.enqueue.mock.calls[0] ?? [];
      expect(payload).toEqual({
        event: 'due_soon',
        to: sampleRow.phone,
        vars: { nama: sampleRow.fullName, jumlah: 'Rp0' },
      });
      expect(jobId).toMatch(new RegExp(`^manual-due_soon:${sampleRow.id}:`));
    });

    it('notifyWhatsapp is best-effort: an enqueue failure does not throw', async () => {
      repo.findById.mockResolvedValue(sampleRow);
      notifications.enqueue.mockRejectedValue(new Error('redis unavailable'));
      await expect(service.notifyWhatsapp(sampleRow.id)).resolves.toMatchObject({
        id: sampleRow.id,
      });
    });

    describe('changePlan', () => {
      // Regression (MUST-FIX #1/#5, PR #121 money review): the plan write
      // AND the delta computation now happen ATOMICALLY inside
      // `CustomersRepository.changePlan` — a single transaction, under a
      // customer-row lock, that re-reads planId and does its own price
      // math. The service no longer computes the delta or calls
      // `updateProfile`/`applyProration` itself (that split is exactly
      // what let two concurrent submits double-charge — see
      // `customers.repository.int-spec.ts`'s `changePlan` describe block
      // for the real atomicity/idempotency coverage). Here we only assert
      // the service validates the target plan, reads `dueDays`, and
      // delegates to the one atomic repo call — nothing else.
      it('validates the target plan then delegates atomically to repo.changePlan', async () => {
        repo.findById.mockResolvedValue(sampleRow);
        plans.findById.mockResolvedValue({
          id: 'plan-new',
          name: 'Pro 100',
          priceMonthly: 500_000,
        });
        repo.changePlan.mockResolvedValue({ applied: true, delta: 300_000 });

        await service.changePlan(sampleRow.id, { planId: 'plan-new' });

        expect(plans.findById).toHaveBeenCalledWith('plan-new');
        expect(settings.getBillingPolicy).toHaveBeenCalled();
        expect(repo.changePlan).toHaveBeenCalledWith(sampleRow.id, {
          targetPlanId: 'plan-new',
          dueDays: 7,
        });
        // No split writes — the service does no money math itself.
        expect(repo.updateProfile).not.toHaveBeenCalled();
        expect(repo.applyProration).not.toHaveBeenCalled();
        expect(repo.setBilling).not.toHaveBeenCalled();
      });

      it('an idempotent no-op result from the repo (applied: false) does not throw', async () => {
        repo.findById.mockResolvedValue(sampleRow);
        plans.findById.mockResolvedValue({ id: PLAN_ID, name: 'Home 20', priceMonthly: 200_000 });
        repo.changePlan.mockResolvedValue({ applied: false, delta: 0 });

        await expect(service.changePlan(sampleRow.id, { planId: PLAN_ID })).resolves.toBeDefined();
      });

      it('rejects an unknown plan with 400 before ever calling the repo', async () => {
        repo.findById.mockResolvedValue(sampleRow);
        plans.findById.mockResolvedValue(null);
        await expect(service.changePlan(sampleRow.id, { planId: 'nope' })).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(repo.changePlan).not.toHaveBeenCalled();
      });

      it('rejects an unknown customer with 404 before ever calling the repo', async () => {
        repo.findById.mockResolvedValue(null);
        await expect(
          service.changePlan('00000000-0000-0000-0000-0000000000ff', { planId: 'plan-new' }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(repo.changePlan).not.toHaveBeenCalled();
      });
    });
  });
});
