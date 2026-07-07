import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractsService } from '../contracts/contracts.service';
import { CoverageService } from '../coverage/coverage.service';
import { CustomersService } from '../customers/customers.service';
import type { CustomerResponse } from '../customers/dto/customer-response.dto';
import { OdpService } from '../odp/odp.service';
import { UsersService } from '../users/users.service';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import type { OnboardCustomerInput } from './dto/onboard-customer.dto';
import { OnboardingService } from './onboarding.service';

const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c1';
const USER_ID = '00000000-0000-0000-0000-0000000000u1';

function customer(over: Partial<CustomerResponse> = {}): CustomerResponse {
  return {
    id: CUSTOMER_ID,
    customerNo: 'CUST-9001',
    fullName: 'Budi Santoso',
    phone: '081234567890',
    email: 'budi@example.com',
    address: 'Jl. Mawar 1',
    areaId: null,
    areaName: 'Bangsri',
    planId: '00000000-0000-0000-0000-0000000000p1',
    planName: 'Home 50',
    status: 'instalasi',
    holdReason: null,
    outstanding: 0,
    billingAnchorDay: null,
    npwp: null,
    ktp: null,
    consentAt: null,
    resellerName: null,
    connection: null,
    joinedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const input: OnboardCustomerInput = {
  fullName: 'Budi Santoso',
  phone: '081234567890',
  email: 'budi@example.com',
  address: 'Jl. Mawar 1',
  areaName: 'Bangsri',
  planId: '00000000-0000-0000-0000-0000000000p1',
  technician: 'Teknisi Andi',
  scheduledAt: '2026-06-20',
  note: 'Rumah pagar hijau',
};

describe('OnboardingService', () => {
  let service: OnboardingService;
  let customers: Record<string, ReturnType<typeof vi.fn>>;
  let workOrders: Record<string, ReturnType<typeof vi.fn>>;
  let users: Record<string, ReturnType<typeof vi.fn>>;
  let coverage: Record<string, ReturnType<typeof vi.fn>>;
  let odp: Record<string, ReturnType<typeof vi.fn>>;
  let contracts: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    customers = { onboard: vi.fn().mockResolvedValue(customer()) };
    workOrders = {
      scheduleInstallForCustomer: vi.fn().mockResolvedValue({ id: 'wo-1' }),
      scheduleInstall: vi.fn().mockResolvedValue({ id: 'wo-2' }),
    };
    users = {
      create: vi.fn().mockResolvedValue({ id: USER_ID, email: 'budi@example.com' }),
    };
    coverage = {
      checkServiceability: vi.fn().mockResolvedValue({ serviceable: true }),
    };
    odp = {
      assignPort: vi.fn().mockResolvedValue({ id: 'odp-1', usedPorts: 1 }),
    };
    contracts = {
      create: vi.fn().mockResolvedValue({ id: 'contract-1' }),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: CustomersService, useValue: customers },
        { provide: WorkOrdersService, useValue: workOrders },
        { provide: UsersService, useValue: users },
        { provide: CoverageService, useValue: coverage },
        { provide: OdpService, useValue: odp },
        { provide: ContractsService, useValue: contracts },
      ],
    }).compile();
    service = moduleRef.get(OnboardingService);
  });

  it('provisions a customer login, links it, and schedules the install WO', async () => {
    const result = await service.onboard(input);

    // The portal login is born here (onboarding-only, no self-signup).
    expect(users.create).toHaveBeenCalledWith({
      email: 'budi@example.com',
      fullName: 'Budi Santoso',
      password: expect.stringMatching(/^[\w-]{18}$/),
      role: 'customer',
    });
    // The customer is created from the profile + area + plan and carries
    // the new login's id (never taken from the HTTP payload).
    expect(customers.onboard).toHaveBeenCalledWith({
      fullName: 'Budi Santoso',
      phone: '081234567890',
      email: 'budi@example.com',
      address: 'Jl. Mawar 1',
      areaName: 'Bangsri',
      planId: '00000000-0000-0000-0000-0000000000p1',
      userId: USER_ID,
      // No geo/KYC/ODP/reseller on the base fixture — all default to null.
      lat: null,
      lng: null,
      odpId: null,
      ktp: null,
      npwp: null,
      consentAt: null,
      resellerId: null,
    });
    // The install work order is linked to the new customer with the chosen
    // technician and date (a real Date, not the raw string).
    expect(workOrders.scheduleInstallForCustomer).toHaveBeenCalledWith({
      customerId: CUSTOMER_ID,
      customerName: 'Budi Santoso',
      technician: 'Teknisi Andi',
      scheduledAt: new Date('2026-06-20'),
    });
    expect(result.id).toBe(CUSTOMER_ID);
    expect(result.status).toBe('instalasi');
    // The initial password surfaces exactly once, in this response.
    expect(result.portalLogin).toEqual({
      email: 'budi@example.com',
      initialPassword: expect.stringMatching(/^[\w-]{18}$/),
    });
    // The serviceability gate ran first, and the draft PKS is auto-created.
    expect(coverage.checkServiceability).toHaveBeenCalledWith('Bangsri');
    expect(contracts.create).toHaveBeenCalledWith(CUSTOMER_ID);
  });

  it('persists the map pin and KYC, stamping consentAt when consent is ticked', async () => {
    await service.onboard({
      ...input,
      lat: -6.5900123,
      lng: 110.6700456,
      ktp: '3320123456780001',
      npwp: '09.254.294.3-407.000',
      consent: true,
    });

    expect(customers.onboard).toHaveBeenCalledWith(
      expect.objectContaining({
        lat: -6.5900123,
        lng: 110.6700456,
        ktp: '3320123456780001',
        npwp: '09.254.294.3-407.000',
        consentAt: expect.any(Date),
      }),
    );
  });

  it('leaves consentAt null when consent is not given', async () => {
    await service.onboard({ ...input, ktp: '3320123456780001', consent: false });

    expect(customers.onboard).toHaveBeenCalledWith(
      expect.objectContaining({ ktp: '3320123456780001', consentAt: null }),
    );
  });

  it('threads a supplied resellerId into customers.onboard (P3.D.2)', async () => {
    const resellerId = '00000000-0000-0000-0000-0000000000a1';
    await service.onboard({ ...input, resellerId });

    expect(customers.onboard).toHaveBeenCalledWith(expect.objectContaining({ resellerId }));
  });

  it('skips login provisioning when the wizard has no email', async () => {
    const result = await service.onboard({ ...input, email: '' });

    expect(users.create).not.toHaveBeenCalled();
    expect(customers.onboard).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));
    expect(result.portalLogin).toBeNull();
  });

  it('creates the customer unlinked when the email already has a login', async () => {
    users.create.mockRejectedValue(new ConflictException('email already in use'));

    const result = await service.onboard(input);

    expect(customers.onboard).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));
    expect(workOrders.scheduleInstallForCustomer).toHaveBeenCalledTimes(1);
    expect(result.portalLogin).toBeNull();
  });

  describe('serviceability gate (P3.A.1)', () => {
    it('blocks onboarding with 422 when the area is not serviceable, and never creates the customer', async () => {
      coverage.checkServiceability.mockResolvedValue({
        serviceable: false,
        reason: 'Area sedang gangguan, belum bisa dilayani',
      });

      await expect(service.onboard(input)).rejects.toThrow(UnprocessableEntityException);
      expect(customers.onboard).not.toHaveBeenCalled();
      expect(users.create).not.toHaveBeenCalled();
      expect(odp.assignPort).not.toHaveBeenCalled();
      expect(contracts.create).not.toHaveBeenCalled();
    });

    it('falls back to a generic Indonesian message when the gate gives no reason', async () => {
      coverage.checkServiceability.mockResolvedValue({ serviceable: false });
      await expect(service.onboard(input)).rejects.toThrow('Area belum terjangkau layanan');
    });

    it('proceeds (a soft warn) when the area is under maintenance', async () => {
      coverage.checkServiceability.mockResolvedValue({
        serviceable: true,
        reason: 'Area sedang dalam pemeliharaan',
      });
      const result = await service.onboard(input);
      expect(result.id).toBe(CUSTOMER_ID);
      expect(customers.onboard).toHaveBeenCalled();
    });
  });

  describe('ODP port reservation (P3.A.1)', () => {
    it('reserves the port when odpId is given, before the customer is created', async () => {
      await service.onboard({ ...input, odpId: 'odp-1' });
      expect(odp.assignPort).toHaveBeenCalledWith('odp-1');
      expect(customers.onboard).toHaveBeenCalledWith(expect.objectContaining({ odpId: 'odp-1' }));
    });

    it('skips port reservation when odpId is not given', async () => {
      await service.onboard(input);
      expect(odp.assignPort).not.toHaveBeenCalled();
      expect(customers.onboard).toHaveBeenCalledWith(expect.objectContaining({ odpId: null }));
    });

    it('propagates the 409 when the ODP is full, and never creates the customer', async () => {
      odp.assignPort.mockRejectedValue(new ConflictException('ODP penuh atau tidak ditemukan'));

      await expect(service.onboard({ ...input, odpId: 'odp-full' })).rejects.toThrow(
        ConflictException,
      );
      expect(customers.onboard).not.toHaveBeenCalled();
      expect(users.create).not.toHaveBeenCalled();
      expect(contracts.create).not.toHaveBeenCalled();
    });
  });

  describe('onboardFromLead (P3.A.2)', () => {
    it('creates an unlinked instalasi customer and an unassigned install WO', async () => {
      const customer = await service.onboardFromLead({
        fullName: 'Budi Santoso',
        phone: '081200000000',
        address: 'Jl. Mawar 1',
        areaName: 'Bangsri',
        planId: '00000000-0000-0000-0000-0000000000p1',
      });

      // Leads carry no email, so no login is provisioned.
      expect(users.create).not.toHaveBeenCalled();
      expect(customers.onboard).toHaveBeenCalledWith(
        expect.objectContaining({ email: '', userId: null, areaName: 'Bangsri' }),
      );
      // Lead convert schedules the install unassigned (no technician/date).
      expect(workOrders.scheduleInstall).toHaveBeenCalledWith({
        customerId: CUSTOMER_ID,
        customerName: 'Budi Santoso',
      });
      expect(workOrders.scheduleInstallForCustomer).not.toHaveBeenCalled();
      expect(customer.id).toBe(CUSTOMER_ID);
      // Same serviceability gate + auto-created draft PKS as the wizard path.
      expect(coverage.checkServiceability).toHaveBeenCalledWith('Bangsri');
      expect(contracts.create).toHaveBeenCalledWith(CUSTOMER_ID);
      // Leads carry no odpId — port assignment is never attempted.
      expect(odp.assignPort).not.toHaveBeenCalled();
    });

    it('forwards resellerId into customers.onboard (P3.D.2)', async () => {
      const resellerId = '00000000-0000-0000-0000-0000000000a1';
      await service.onboardFromLead({
        fullName: 'Budi Santoso',
        phone: '081200000000',
        address: 'Jl. Mawar 1',
        areaName: 'Bangsri',
        planId: '00000000-0000-0000-0000-0000000000p1',
        resellerId,
      });

      expect(customers.onboard).toHaveBeenCalledWith(expect.objectContaining({ resellerId }));
    });

    it('defaults resellerId to null when the lead carries none', async () => {
      await service.onboardFromLead({
        fullName: 'Budi Santoso',
        phone: '081200000000',
        address: 'Jl. Mawar 1',
        areaName: 'Bangsri',
        planId: '00000000-0000-0000-0000-0000000000p1',
      });

      expect(customers.onboard).toHaveBeenCalledWith(expect.objectContaining({ resellerId: null }));
    });

    it('blocks the lead conversion with 422 when the area is not serviceable', async () => {
      coverage.checkServiceability.mockResolvedValue({
        serviceable: false,
        reason: 'Area sedang gangguan, belum bisa dilayani',
      });

      await expect(
        service.onboardFromLead({
          fullName: 'Budi Santoso',
          phone: '081200000000',
          address: 'Jl. Mawar 1',
          areaName: 'Bangsri',
          planId: '00000000-0000-0000-0000-0000000000p1',
        }),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(customers.onboard).not.toHaveBeenCalled();
      expect(contracts.create).not.toHaveBeenCalled();
    });
  });
});
