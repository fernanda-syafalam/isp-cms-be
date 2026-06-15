import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoice } from '../../infrastructure/database/schema/invoices.schema';
import { InvoicesRepository } from '../invoices/invoices.repository';
import { AccountingService } from './accounting.service';

function paidInvoice(over: Partial<Invoice>): Invoice {
  return {
    id: '00000000-0000-0000-0000-00000000e001',
    invoiceNo: 'INV-2026-100',
    customerId: '00000000-0000-0000-0000-0000000000c1',
    customerName: 'Budi',
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    amount: 200_000,
    lateFee: 0,
    taxAmount: 0,
    taxInvoiceNo: null,
    status: 'paid',
    dueDate: '2026-05-10',
    paidAt: new Date('2026-05-03T10:30:00.000Z'),
    lastRemindedAt: null,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-03T10:30:00.000Z'),
    ...over,
  };
}

describe('AccountingService', () => {
  let service: AccountingService;
  let invoices: { findPaidInPeriod: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    invoices = { findPaidInPeriod: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [AccountingService, { provide: InvoicesRepository, useValue: invoices }],
    }).compile();
    service = moduleRef.get(AccountingService);
  });

  it('builds a balanced two-line journal for a plain paid invoice', async () => {
    invoices.findPaidInPeriod.mockResolvedValue([
      paidInvoice({ amount: 200_000, taxAmount: 0, lateFee: 0 }),
    ]);
    const journal = await service.getJournal('2026-05');

    expect(invoices.findPaidInPeriod).toHaveBeenCalledWith('2026-05');
    expect(journal.period).toBe('2026-05');
    expect(journal.lines).toHaveLength(2); // cash debit + revenue credit
    expect(journal.lines[0]).toMatchObject({ accountCode: '1110', debit: 200_000, credit: 0 });
    expect(journal.lines[1]).toMatchObject({ accountCode: '4100', debit: 0, credit: 200_000 });
    expect(journal.totals).toEqual({ debit: 200_000, credit: 200_000 });
  });

  it('adds late-fee and output-VAT credit lines and stays balanced', async () => {
    invoices.findPaidInPeriod.mockResolvedValue([
      paidInvoice({ id: 'inv1', amount: 350_000, lateFee: 25_000, taxAmount: 200_000 }),
    ]);
    const journal = await service.getJournal('2026-05');

    // cash debit + revenue + late-fee + vat
    expect(journal.lines.map((l) => l.accountCode)).toEqual(['1110', '4100', '4200', '2130']);
    expect(journal.lines[0]?.debit).toBe(575_000); // 350k + 25k + 200k
    expect(journal.totals.debit).toBe(575_000);
    expect(journal.totals.credit).toBe(575_000);
    expect(journal.lines.find((l) => l.accountCode === '4200')?.credit).toBe(25_000);
    expect(journal.lines.find((l) => l.accountCode === '2130')?.credit).toBe(200_000);
  });

  it('omits zero late-fee / VAT lines and returns an empty balanced journal for no data', async () => {
    invoices.findPaidInPeriod.mockResolvedValue([]);
    const journal = await service.getJournal('2026-09');
    expect(journal.lines).toEqual([]);
    expect(journal.totals).toEqual({ debit: 0, credit: 0 });
  });
});
