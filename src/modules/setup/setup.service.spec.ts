import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BranchesRepository } from '../branches/branches.repository';
import { CustomersRepository } from '../customers/customers.repository';
import { PlansRepository } from '../plans/plans.repository';
import { PoolsRepository } from '../router-resources/pools.repository';
import { ProfilesRepository } from '../router-resources/profiles.repository';
import { RoutersRepository } from '../routers/routers.repository';
import { SettingsService } from '../settings/settings.service';
import { UsersRepository } from '../users/users.repository';
import { WorkOrdersRepository } from '../work-orders/work-orders.repository';
import { SetupService } from './setup.service';

const statusCounts = { prospek: 0, instalasi: 0, aktif: 0, isolir: 0, berhenti: 0 };

const settingsResponse = {
  company: {
    name: 'Jepara Net',
    address: 'Jl. Pemuda No. 12',
    phone: '0291-591234',
    email: 'a@b.co',
  },
  billing: { lateFeeIdr: 25_000, dueDays: 10, isolirGraceDays: 3 },
  tax: { pkp: true, npwp: '01.234.567.8-901.000', ppnRate: 0.11 },
};

describe('SetupService', () => {
  let service: SetupService;
  let plans: Record<string, ReturnType<typeof vi.fn>>;
  let routers: Record<string, ReturnType<typeof vi.fn>>;
  let profiles: Record<string, ReturnType<typeof vi.fn>>;
  let pools: Record<string, ReturnType<typeof vi.fn>>;
  let branches: Record<string, ReturnType<typeof vi.fn>>;
  let settings: Record<string, ReturnType<typeof vi.fn>>;
  let users: Record<string, ReturnType<typeof vi.fn>>;
  let customers: Record<string, ReturnType<typeof vi.fn>>;
  let workOrders: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    plans = { list: vi.fn().mockResolvedValue({ items: [], total: 0 }) };
    routers = { list: vi.fn().mockResolvedValue({ items: [], total: 0 }) };
    profiles = { countAll: vi.fn().mockResolvedValue(0) };
    pools = { countAll: vi.fn().mockResolvedValue(0) };
    branches = { list: vi.fn().mockResolvedValue({ items: [], total: 0 }) };
    settings = { get: vi.fn().mockResolvedValue(settingsResponse) };
    users = { countByRoles: vi.fn().mockResolvedValue(0) };
    customers = { countByStatus: vi.fn().mockResolvedValue(statusCounts) };
    workOrders = { list: vi.fn().mockResolvedValue({ items: [], total: 0 }) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SetupService,
        { provide: PlansRepository, useValue: plans },
        { provide: RoutersRepository, useValue: routers },
        { provide: ProfilesRepository, useValue: profiles },
        { provide: PoolsRepository, useValue: pools },
        { provide: BranchesRepository, useValue: branches },
        { provide: SettingsService, useValue: settings },
        { provide: UsersRepository, useValue: users },
        { provide: CustomersRepository, useValue: customers },
        { provide: WorkOrdersRepository, useValue: workOrders },
      ],
    }).compile();
    service = moduleRef.get(SetupService);
  });

  it('reports every step not done against an empty database', async () => {
    const result = await service.getStatus();

    expect(result.catalogue).toEqual({ done: false, plansCount: 0 });
    expect(result.network).toEqual({
      done: false,
      routersCount: 0,
      profilesCount: 0,
      poolsCount: 0,
    });
    expect(result.branches).toEqual({ done: false, branchesCount: 0 });
    expect(result.staff).toEqual({ done: false, staffCount: 0 });
    expect(result.onboarding).toEqual({ done: false, instalasiCount: 0, aktifCount: 0 });
    expect(result.workOrders).toEqual({ done: false, installDoneCount: 0 });
    expect(result.active).toEqual({ done: false, activeCount: 0 });
  });

  describe('network — the exact bug being fixed', () => {
    it('is NOT done when a router exists but no profile is provisioned', async () => {
      routers.list.mockResolvedValue({ items: [{ id: 'r1' }], total: 1 });
      pools.countAll.mockResolvedValue(3);
      profiles.countAll.mockResolvedValue(0);

      const result = await service.getStatus();

      expect(result.network.done).toBe(false);
      expect(result.network.routersCount).toBe(1);
      expect(result.network.poolsCount).toBe(3);
      expect(result.network.profilesCount).toBe(0);
    });

    it('is NOT done when a router exists but no pool is provisioned', async () => {
      routers.list.mockResolvedValue({ items: [{ id: 'r1' }], total: 1 });
      profiles.countAll.mockResolvedValue(2);
      pools.countAll.mockResolvedValue(0);

      const result = await service.getStatus();

      expect(result.network.done).toBe(false);
    });

    it('is done only once router, profile and pool all exist', async () => {
      routers.list.mockResolvedValue({ items: [{ id: 'r1' }], total: 1 });
      profiles.countAll.mockResolvedValue(1);
      pools.countAll.mockResolvedValue(1);

      const result = await service.getStatus();

      expect(result.network.done).toBe(true);
    });
  });

  describe('catalogue', () => {
    it('flips done once at least one plan exists', async () => {
      plans.list.mockResolvedValue({ items: [{ id: 'p1' }], total: 1 });

      const result = await service.getStatus();

      expect(result.catalogue).toEqual({ done: true, plansCount: 1 });
    });
  });

  describe('branches', () => {
    it('flips done once at least one branch exists', async () => {
      branches.list.mockResolvedValue({ items: [{ id: 'b1' }], total: 1 });

      const result = await service.getStatus();

      expect(result.branches).toEqual({ done: true, branchesCount: 1 });
    });
  });

  describe('staff — the boundary at "beyond the bootstrap admin"', () => {
    it('is NOT done at count 1 (the bootstrap admin alone)', async () => {
      users.countByRoles.mockResolvedValue(1);

      const result = await service.getStatus();

      expect(result.staff).toEqual({ done: false, staffCount: 1 });
    });

    it('is done at count 2 (bootstrap admin + one more staff/admin)', async () => {
      users.countByRoles.mockResolvedValue(2);

      const result = await service.getStatus();

      expect(result.staff).toEqual({ done: true, staffCount: 2 });
      // Asked for exactly the two roles that count as "staff configured".
      expect(users.countByRoles).toHaveBeenCalledWith(['admin', 'staff']);
    });
  });

  describe('settings — configured-company-name detection', () => {
    it('is NOT done when the company name is blank', async () => {
      settings.get.mockResolvedValue({
        ...settingsResponse,
        company: { ...settingsResponse.company, name: '   ' },
      });

      const result = await service.getStatus();

      expect(result.settings.done).toBe(false);
    });

    it('is done when the company name is set', async () => {
      const result = await service.getStatus();

      expect(result.settings).toEqual({ done: true, companyName: 'Jepara Net' });
    });
  });

  describe('onboarding', () => {
    it('is done when there is at least one instalasi customer', async () => {
      customers.countByStatus.mockResolvedValue({ ...statusCounts, instalasi: 1 });

      const result = await service.getStatus();

      expect(result.onboarding).toEqual({ done: true, instalasiCount: 1, aktifCount: 0 });
    });

    it('is done when there is at least one aktif customer', async () => {
      customers.countByStatus.mockResolvedValue({ ...statusCounts, aktif: 1 });

      const result = await service.getStatus();

      expect(result.onboarding).toEqual({ done: true, instalasiCount: 0, aktifCount: 1 });
    });
  });

  describe('workOrders', () => {
    it('is done once an install work order has status done', async () => {
      workOrders.list.mockResolvedValue({ items: [{ id: 'wo1' }], total: 1 });

      const result = await service.getStatus();

      expect(result.workOrders).toEqual({ done: true, installDoneCount: 1 });
      expect(workOrders.list).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'install', status: 'done' }),
      );
    });
  });

  describe('active', () => {
    it('is done when there is at least one aktif customer', async () => {
      customers.countByStatus.mockResolvedValue({ ...statusCounts, aktif: 5 });

      const result = await service.getStatus();

      expect(result.active).toEqual({ done: true, activeCount: 5 });
    });
  });
});
