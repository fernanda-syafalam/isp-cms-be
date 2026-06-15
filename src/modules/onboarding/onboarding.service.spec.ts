import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomersService } from '../customers/customers.service';
import type { CustomerResponse } from '../customers/dto/customer-response.dto';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import type { OnboardCustomerInput } from './dto/onboard-customer.dto';
import { OnboardingService } from './onboarding.service';

const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c1';

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

  beforeEach(async () => {
    customers = { onboard: vi.fn().mockResolvedValue(customer()) };
    workOrders = { scheduleInstallForCustomer: vi.fn().mockResolvedValue({ id: 'wo-1' }) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: CustomersService, useValue: customers },
        { provide: WorkOrdersService, useValue: workOrders },
      ],
    }).compile();
    service = moduleRef.get(OnboardingService);
  });

  it('creates the subscriber and a linked install work order, returning the customer', async () => {
    const result = await service.onboard(input);

    // The customer is created from the profile + area + plan (no schedule fields).
    expect(customers.onboard).toHaveBeenCalledWith({
      fullName: 'Budi Santoso',
      phone: '081234567890',
      email: 'budi@example.com',
      address: 'Jl. Mawar 1',
      areaName: 'Bangsri',
      planId: '00000000-0000-0000-0000-0000000000p1',
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
  });
});
