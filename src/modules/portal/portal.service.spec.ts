import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { CustomersService } from '../customers/customers.service';
import type { CustomerResponse } from '../customers/dto/customer-response.dto';
import { InvoicesService } from '../invoices/invoices.service';
import { TicketsService } from '../tickets/tickets.service';
import { PortalService } from './portal.service';

const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c1';

const user: AuthUser = {
  id: '00000000-0000-0000-0000-0000000000u1',
  email: 'budi@example.com',
  fullName: 'Budi Santoso',
  role: 'customer',
};

function customer(over: Partial<CustomerResponse> = {}): CustomerResponse {
  return {
    id: CUSTOMER_ID,
    customerNo: 'CUST-9001',
    fullName: 'Budi Santoso',
    phone: '0811',
    email: 'budi@example.com',
    address: 'Jl. Mawar',
    areaId: null,
    areaName: null,
    planId: '00000000-0000-0000-0000-0000000000p1',
    planName: 'Home 50',
    status: 'aktif',
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

describe('PortalService', () => {
  let service: PortalService;
  let customers: Record<string, ReturnType<typeof vi.fn>>;
  let invoices: Record<string, ReturnType<typeof vi.fn>>;
  let tickets: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    customers = { resolveForPortal: vi.fn().mockResolvedValue(customer()) };
    invoices = {
      invoicesByCustomer: vi.fn().mockResolvedValue([{ id: 'inv-1' }]),
      paymentsByCustomer: vi.fn().mockResolvedValue([{ id: 'pay-1' }]),
    };
    tickets = {
      listByCustomer: vi.fn().mockResolvedValue([{ id: 'tkt-1' }]),
      create: vi.fn(),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PortalService,
        { provide: CustomersService, useValue: customers },
        { provide: InvoicesService, useValue: invoices },
        { provide: TicketsService, useValue: tickets },
      ],
    }).compile();
    service = moduleRef.get(PortalService);
  });

  describe('getMe', () => {
    it('resolves the customer by session email and aggregates their data', async () => {
      const snapshot = await service.getMe(user);

      expect(customers.resolveForPortal).toHaveBeenCalledWith('budi@example.com');
      expect(invoices.invoicesByCustomer).toHaveBeenCalledWith(CUSTOMER_ID);
      expect(invoices.paymentsByCustomer).toHaveBeenCalledWith(CUSTOMER_ID);
      expect(tickets.listByCustomer).toHaveBeenCalledWith(CUSTOMER_ID);
      expect(snapshot.customer.id).toBe(CUSTOMER_ID);
      expect(snapshot.invoices).toHaveLength(1);
      expect(snapshot.payments).toHaveLength(1);
      expect(snapshot.tickets).toHaveLength(1);
    });
  });

  describe('reportIssue', () => {
    it('opens a medium-priority ticket on the resolved customer account', async () => {
      await service.reportIssue(user, { subject: 'Internet mati sejak pagi' });

      expect(tickets.create).toHaveBeenCalledWith(
        {
          subject: 'Internet mati sejak pagi',
          customerName: 'Budi Santoso',
          priority: 'medium',
        },
        'Budi Santoso',
      );
    });
  });
});
