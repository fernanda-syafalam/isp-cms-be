import { ConflictException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomersService } from '../customers/customers.service';
import type { CustomerResponse } from '../customers/dto/customer-response.dto';
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

  beforeEach(async () => {
    customers = { onboard: vi.fn().mockResolvedValue(customer()) };
    workOrders = {
      scheduleInstallForCustomer: vi.fn().mockResolvedValue({ id: 'wo-1' }),
      scheduleInstall: vi.fn().mockResolvedValue({ id: 'wo-2' }),
    };
    users = {
      create: vi.fn().mockResolvedValue({ id: USER_ID, email: 'budi@example.com' }),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: CustomersService, useValue: customers },
        { provide: WorkOrdersService, useValue: workOrders },
        { provide: UsersService, useValue: users },
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
    });
  });
});
