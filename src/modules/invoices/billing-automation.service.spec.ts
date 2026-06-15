import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomersRepository } from '../customers/customers.repository';
import { BillingAutomationService } from './billing-automation.service';
import { InvoicesRepository } from './invoices.repository';
import { InvoicesService } from './invoices.service';

describe('BillingAutomationService', () => {
  let service: BillingAutomationService;
  let invoicesService: { run: ReturnType<typeof vi.fn> };
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: {
    findById: ReturnType<typeof vi.fn>;
    setBilling: ReturnType<typeof vi.fn>;
    findActiveBillable: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    invoicesService = { run: vi.fn() };
    repo = {
      markOverduePastDue: vi.fn(),
      countOverdueAll: vi.fn(),
      countPendingDueSoon: vi.fn(),
      markRemindedOverdue: vi.fn(),
      markRemindedDueSoon: vi.fn(),
      markRemindedByIds: vi.fn(),
      customerIdsWithOverdue: vi.fn(),
      sumUnpaidByCustomer: vi.fn(),
      existsForPeriod: vi.fn(),
    };
    customers = { findById: vi.fn(), setBilling: vi.fn(), findActiveBillable: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BillingAutomationService,
        { provide: InvoicesService, useValue: invoicesService },
        { provide: InvoicesRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
      ],
    }).compile();
    service = moduleRef.get(BillingAutomationService);
  });

  describe('isolirOverdue', () => {
    it('marks overdue then isolates only active debtors', async () => {
      repo.markOverduePastDue.mockResolvedValue(3);
      repo.customerIdsWithOverdue.mockResolvedValue(['c1', 'c2']);
      customers.findById.mockImplementation((id: string) =>
        Promise.resolve({ id, status: id === 'c1' ? 'aktif' : 'isolir' }),
      );
      repo.sumUnpaidByCustomer.mockResolvedValue(247_000);

      const result = await service.isolirOverdue();

      expect(repo.markOverduePastDue).toHaveBeenCalledWith(25_000);
      // c1 (aktif) gets isolated; c2 (already isolir) is skipped
      expect(customers.setBilling).toHaveBeenCalledTimes(1);
      expect(customers.setBilling).toHaveBeenCalledWith('c1', {
        status: 'isolir',
        outstanding: 247_000,
      });
      expect(result).toEqual({ markedOverdue: 3, isolated: 1 });
    });
  });

  describe('remind', () => {
    it('reminds explicit ids when provided', async () => {
      repo.markRemindedByIds.mockResolvedValue(2);
      const result = await service.remind({ invoiceIds: ['a', 'b'] });
      expect(repo.markRemindedByIds).toHaveBeenCalledWith(['a', 'b']);
      expect(repo.markRemindedOverdue).not.toHaveBeenCalled();
      expect(result).toEqual({ reminded: 2, channel: 'whatsapp' });
    });

    it('reminds all overdue when no ids given', async () => {
      repo.markRemindedOverdue.mockResolvedValue(5);
      const result = await service.remind({});
      expect(repo.markRemindedOverdue).toHaveBeenCalled();
      expect(result.reminded).toBe(5);
    });
  });

  it('schedulerPreview counts to-bill (active without current invoice), dunning + isolir', async () => {
    customers.findActiveBillable.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    repo.existsForPeriod.mockImplementation((id: string) => Promise.resolve(id === 'c2'));
    repo.countPendingDueSoon.mockResolvedValue(4);
    repo.countOverdueAll.mockResolvedValue(6);
    repo.customerIdsWithOverdue.mockResolvedValue(['c1']);
    customers.findById.mockResolvedValue({ id: 'c1', status: 'aktif' });

    const result = await service.schedulerPreview();
    expect(result).toEqual({ toBill: 1, toRemindUpcoming: 4, toRemindOverdue: 6, toIsolir: 1 });
  });

  it('schedulerRun chains run -> overdue -> dun -> isolir', async () => {
    invoicesService.run.mockResolvedValue({ period: '2026-06', created: 7 });
    repo.markOverduePastDue.mockResolvedValue(2);
    repo.markRemindedDueSoon.mockResolvedValue(3);
    repo.markRemindedOverdue.mockResolvedValue(2);
    repo.customerIdsWithOverdue.mockResolvedValue([]);

    const result = await service.schedulerRun();
    expect(result).toEqual({
      period: '2026-06',
      created: 7,
      remindedUpcoming: 3,
      remindedOverdue: 2,
      isolated: 0,
    });
  });
});
