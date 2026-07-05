import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoice } from '../../infrastructure/database/schema/invoices.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { ResellersRepository } from '../resellers/resellers.repository';
import { SecretsRepository } from '../router-resources/secrets.repository';
import { SettingsService } from '../settings/settings.service';
import { InvoicesRepository } from './invoices.repository';
import { InvoicesService } from './invoices.service';

const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c1';

const pendingInvoice: Invoice = {
  id: '00000000-0000-0000-0000-0000000000e1',
  invoiceNo: 'INV-2026-100',
  customerId: CUSTOMER_ID,
  customerName: 'Budi Santoso',
  periodStart: '2026-06-01',
  periodEnd: '2026-06-30',
  amount: 200_000,
  lateFee: 0,
  taxAmount: 22_000,
  taxInvoiceNo: null,
  status: 'pending',
  dueDate: '2026-06-10',
  paidAt: null,
  lastRemindedAt: null,
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
};

// Default full-set summary returned by the mock repo
const defaultSummary = {
  outstanding: 444_000,
  overdue: 222_000,
  unpaidCount: 2,
  total: 5,
};

describe('InvoicesService', () => {
  let service: InvoicesService;
  let resellersFake: {
    findById: ReturnType<typeof vi.fn>;
    postCommissionForInvoice: ReturnType<typeof vi.fn>;
  };
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: Record<string, ReturnType<typeof vi.fn>>;
  let secrets: { setDisabledByCustomerId: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      existsForPeriod: vi.fn(),
      markPaid: vi.fn(),
      sumUnpaidByCustomer: vi.fn(),
      countOverdueByCustomer: vi.fn(),
      listPayments: vi.fn(),
      createPayment: vi.fn(),
    };
    customers = {
      findActiveBillable: vi.fn(),
      setBilling: vi.fn(),
      // Default: no reseller, so commission is a no-op unless a test overrides.
      findById: vi.fn().mockResolvedValue({ id: 'c1', resellerId: null }),
      findBillingInfo: vi.fn(),
    };
    secrets = { setDisabledByCustomerId: vi.fn() };
    const resellers = {
      findById: vi.fn(),
      postCommissionForInvoice: vi.fn().mockResolvedValue(true),
    };
    const settings = {
      getBillingPolicy: vi.fn().mockResolvedValue({
        pkp: true,
        ppnRate: 0.11,
        dueDays: 10,
        lateFeeIdr: 25_000,
        isolirGraceDays: 3,
      }),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: InvoicesRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
        { provide: SecretsRepository, useValue: secrets },
        { provide: SettingsService, useValue: settings },
        { provide: ResellersRepository, useValue: resellers },
      ],
    }).compile();
    service = moduleRef.get(InvoicesService);
    resellersFake = resellers;
  });

  // ---------------------------------------------------------------------------
  // list — pagination, search, sort, and summary invariant
  // ---------------------------------------------------------------------------

  describe('list', () => {
    it('maps invoices, passes total through, and includes summary', async () => {
      repo.list.mockResolvedValue({ items: [pendingInvoice], total: 1, summary: defaultSummary });
      const result = await service.list({ limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.invoiceNo).toBe('INV-2026-100');
      // dates project to plain calendar strings; paidAt is null
      expect(result.items[0]?.periodStart).toBe('2026-06-01');
      expect(result.items[0]?.paidAt).toBeNull();
      expect(result.summary).toEqual(defaultSummary);
    });

    it('status filter shrinks items and total but summary is unchanged (the invariant)', async () => {
      const overdueInvoice: Invoice = {
        ...pendingInvoice,
        id: '00000000-0000-0000-0000-0000000000e2',
        status: 'overdue',
      };
      repo.list.mockResolvedValue({
        items: [overdueInvoice],
        total: 1,
        summary: defaultSummary,
      });
      const result = await service.list({ status: 'overdue', limit: 50, offset: 0 });
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      // Summary must reflect the full set, not just the filtered slice.
      expect(result.summary.total).toBe(5);
      expect(result.summary.unpaidCount).toBe(2);
      expect(result.summary.outstanding).toBe(444_000);
      expect(result.summary.overdue).toBe(222_000);
    });

    it('q search passes the filter to the repo and summary is unaffected', async () => {
      const matched: Invoice = { ...pendingInvoice, invoiceNo: 'INV-2026-999' };
      repo.list.mockResolvedValue({ items: [matched], total: 1, summary: defaultSummary });
      const result = await service.list({ q: 'INV-2026-999', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'INV-2026-999' }));
      expect(result.items[0]?.invoiceNo).toBe('INV-2026-999');
      expect(result.total).toBe(1);
      // Summary unaffected by q.
      expect(result.summary).toEqual(defaultSummary);
    });

    it('forwards sort and order to the repo', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0, summary: defaultSummary });
      await service.list({ sort: 'dueDate', order: 'asc', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'dueDate', order: 'asc' }),
      );
    });

    it('forwards desc sort to the repo', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0, summary: defaultSummary });
      await service.list({ sort: 'customerName', order: 'desc', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'customerName', order: 'desc' }),
      );
    });

    it('unknown sort key is forwarded to the repo (repo falls back to default via buildOrderBy)', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0, summary: defaultSummary });
      await service.list({ sort: 'thisKeyDoesNotExist', order: 'asc', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'thisKeyDoesNotExist' }),
      );
    });

    it('limit/offset paging keeps total and summary unaffected', async () => {
      const page2Item: Invoice = {
        ...pendingInvoice,
        id: '00000000-0000-0000-0000-0000000000e9',
      };
      repo.list.mockResolvedValue({
        items: [page2Item],
        total: 50,
        summary: defaultSummary,
      });
      const result = await service.list({ limit: 10, offset: 10 });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, offset: 10 }));
      // total is full filtered count, not just page size
      expect(result.total).toBe(50);
      // summary is always full-set
      expect(result.summary).toEqual(defaultSummary);
    });

    it('outstanding includes both pending and overdue grand totals', async () => {
      const summaryWithMix = {
        outstanding: 700_000, // pending 300k + overdue 400k
        overdue: 400_000,
        unpaidCount: 3,
        total: 10,
      };
      repo.list.mockResolvedValue({ items: [], total: 0, summary: summaryWithMix });
      const result = await service.list({ limit: 50, offset: 0 });
      expect(result.summary.outstanding).toBe(700_000);
      expect(result.summary.overdue).toBe(400_000);
      expect(result.summary.unpaidCount).toBe(3);
    });
  });

  it('findById throws 404 when absent', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.findById('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('pay', () => {
    it('settles the invoice, writes the full total to the ledger, and reactivates an isolated customer', async () => {
      repo.findById.mockResolvedValue(pendingInvoice);
      repo.markPaid.mockResolvedValue({
        ...pendingInvoice,
        status: 'paid',
        paidAt: new Date('2026-06-15T10:00:00.000Z'),
      });
      repo.sumUnpaidByCustomer.mockResolvedValue(0);
      repo.countOverdueByCustomer.mockResolvedValue(0);
      customers.findById.mockResolvedValue({
        id: CUSTOMER_ID,
        status: 'isolir',
      });

      const result = await service.pay(pendingInvoice.id, {
        method: 'transfer',
      });

      expect(repo.markPaid).toHaveBeenCalledWith(pendingInvoice.id);
      // total = amount + lateFee + taxAmount
      expect(repo.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 222_000,
          method: 'transfer',
          invoiceNo: 'INV-2026-100',
        }),
      );
      // no debt left + no overdue -> reactivate from isolir
      expect(customers.setBilling).toHaveBeenCalledWith(CUSTOMER_ID, {
        outstanding: 0,
        status: 'aktif',
      });
      // ADR-0008: reactivation re-enables the PPPoE secret on the router.
      expect(secrets.setDisabledByCustomerId).toHaveBeenCalledWith(CUSTOMER_ID, false);
      expect(result.status).toBe('paid');
      expect(result.paidAt).toBe('2026-06-15T10:00:00.000Z');
      // No reseller on this customer → no commission (P3.D.1).
      expect(resellersFake.postCommissionForInvoice).not.toHaveBeenCalled();
    });

    it('posts the acquiring reseller commission on payment, keyed by invoice (P3.D.1)', async () => {
      repo.findById.mockResolvedValue(pendingInvoice);
      repo.markPaid.mockResolvedValue({ ...pendingInvoice, status: 'paid', paidAt: new Date() });
      repo.sumUnpaidByCustomer.mockResolvedValue(0);
      repo.countOverdueByCustomer.mockResolvedValue(0);
      customers.findById.mockResolvedValue({
        id: CUSTOMER_ID,
        status: 'aktif',
        resellerId: 'r-1',
      });
      resellersFake.findById.mockResolvedValue({ id: 'r-1', commissionPct: 0.05 });

      await service.pay(pendingInvoice.id, { method: 'transfer' });

      // 5% of the 222_000 total.
      expect(resellersFake.postCommissionForInvoice).toHaveBeenCalledWith({
        resellerId: 'r-1',
        amount: 11_100,
        invoiceId: pendingInvoice.id,
        note: expect.stringContaining(pendingInvoice.id),
      });
    });

    it('skips commission when the reseller rate is zero', async () => {
      repo.findById.mockResolvedValue(pendingInvoice);
      repo.markPaid.mockResolvedValue({ ...pendingInvoice, status: 'paid', paidAt: new Date() });
      repo.sumUnpaidByCustomer.mockResolvedValue(0);
      repo.countOverdueByCustomer.mockResolvedValue(0);
      customers.findById.mockResolvedValue({ id: CUSTOMER_ID, status: 'aktif', resellerId: 'r-1' });
      resellersFake.findById.mockResolvedValue({ id: 'r-1', commissionPct: 0 });

      await service.pay(pendingInvoice.id, { method: 'transfer' });

      expect(resellersFake.postCommissionForInvoice).not.toHaveBeenCalled();
    });

    it('keeps an active customer active and only refreshes the balance', async () => {
      repo.findById.mockResolvedValue(pendingInvoice);
      repo.markPaid.mockResolvedValue({
        ...pendingInvoice,
        status: 'paid',
        paidAt: new Date(),
      });
      repo.sumUnpaidByCustomer.mockResolvedValue(50_000);
      repo.countOverdueByCustomer.mockResolvedValue(1);
      customers.findById.mockResolvedValue({
        id: CUSTOMER_ID,
        status: 'aktif',
      });

      await service.pay(pendingInvoice.id, { method: 'cash' });
      expect(customers.setBilling).toHaveBeenCalledWith(CUSTOMER_ID, {
        outstanding: 50_000,
      });
      // Still in debt -> no reactivation, so the secret is left untouched.
      expect(secrets.setDisabledByCustomerId).not.toHaveBeenCalled();
    });

    it('is a no-op for an already-paid invoice (no duplicate ledger entry)', async () => {
      repo.findById.mockResolvedValue({ ...pendingInvoice, status: 'paid' });
      const result = await service.pay(pendingInvoice.id, { method: 'qris' });
      expect(repo.markPaid).not.toHaveBeenCalled();
      expect(repo.createPayment).not.toHaveBeenCalled();
      expect(customers.setBilling).not.toHaveBeenCalled();
      expect(result.status).toBe('paid');
    });

    it('throws 404 for an unknown invoice', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.pay('missing', { method: 'cash' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('run', () => {
    it('creates invoices only for active customers without one this period, applying PPN', async () => {
      customers.findActiveBillable.mockResolvedValue([
        { id: 'c1', fullName: 'Ani', planPriceMonthly: 200_000 },
        { id: 'c2', fullName: 'Budi', planPriceMonthly: 300_000 },
      ]);
      repo.existsForPeriod.mockImplementation((id: string) => Promise.resolve(id === 'c2'));
      repo.create.mockResolvedValue(pendingInvoice);

      const result = await service.run();

      expect(result.created).toBe(1);
      expect(result.period).toMatch(/^\d{4}-\d{2}$/);
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'c1',
          amount: 200_000,
          taxAmount: 22_000, // round(200000 * 0.11)
          status: 'pending',
        }),
      );
    });
  });

  it('maps the payment ledger', async () => {
    repo.listPayments.mockResolvedValue({
      items: [
        {
          id: '00000000-0000-0000-0000-0000000000f1',
          invoiceId: pendingInvoice.id,
          invoiceNo: 'INV-2026-100',
          customerId: CUSTOMER_ID,
          customerName: 'Budi Santoso',
          amount: 222_000,
          method: 'transfer',
          paidAt: new Date('2026-06-15T10:00:00.000Z'),
          createdAt: new Date('2026-06-15T10:00:00.000Z'),
        },
      ],
      total: 1,
    });
    const result = await service.listPayments({ limit: 50, offset: 0 });
    expect(result.items[0]?.paidAt).toBe('2026-06-15T10:00:00.000Z');
    expect(result.items[0]?.amount).toBe(222_000);
  });
});
