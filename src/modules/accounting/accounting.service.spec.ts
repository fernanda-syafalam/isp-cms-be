import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoice } from '../../infrastructure/database/schema/invoices.schema';
import { InvoicesRepository } from '../invoices/invoices.repository';
import { AccountingService, type JournalFilter } from './accounting.service';

function paidInvoice(over: Partial<Invoice>): Invoice {
  return {
    id: '00000000-0000-0000-0000-00000000e001',
    invoiceNo: 'INV-2026-100',
    customerId: '00000000-0000-0000-0000-0000000000c1',
    customerName: 'Budi',
    type: 'regular',
    note: null,
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    amount: 200_000,
    lateFee: 0,
    taxAmount: 0,
    discountAmount: 0,
    paidAmount: 0,
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

/** Default filter — no pagination limit needed for small seed data */
function filter(over: Partial<JournalFilter> = {}): JournalFilter {
  return { period: '2026-05', limit: 200, offset: 0, ...over };
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

  // -------------------------------------------------------------------------
  // Original behaviour preserved
  // -------------------------------------------------------------------------

  it('builds a balanced two-line journal for a plain paid invoice', async () => {
    invoices.findPaidInPeriod.mockResolvedValue([
      paidInvoice({ amount: 200_000, taxAmount: 0, lateFee: 0 }),
    ]);
    const journal = await service.getJournal(filter());

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
    const journal = await service.getJournal(filter());

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
    const journal = await service.getJournal(filter({ period: '2026-09' }));
    expect(journal.lines).toEqual([]);
    expect(journal.totals).toEqual({ debit: 0, credit: 0 });
  });

  // -------------------------------------------------------------------------
  // (a) Unfiltered: total == full line count
  // -------------------------------------------------------------------------

  it('(a) unfiltered: total equals the full line count', async () => {
    // Two invoices → 2 debit + 2 revenue = 4 lines
    invoices.findPaidInPeriod.mockResolvedValue([
      paidInvoice({ id: 'inv-a1', invoiceNo: 'INV-A1', amount: 100_000 }),
      paidInvoice({ id: 'inv-a2', invoiceNo: 'INV-A2', amount: 200_000 }),
    ]);
    const journal = await service.getJournal(filter());

    expect(journal.lines).toHaveLength(4);
    expect(journal.total).toBe(4);
  });

  // -------------------------------------------------------------------------
  // (b) q-filter: filters lines case-insensitively and total drops
  // -------------------------------------------------------------------------

  it('(b) q filters lines case-insensitively by accountName and total drops', async () => {
    invoices.findPaidInPeriod.mockResolvedValue([
      paidInvoice({ id: 'inv-b1', invoiceNo: 'INV-B1', amount: 100_000, lateFee: 10_000 }),
    ]);
    // Lines: 1110 (Kas & Bank), 4100 (Pendapatan Jasa Internet), 4200 (Pendapatan Denda)
    // Searching "KAS" should match only the 1110 debit line.
    const journal = await service.getJournal(filter({ q: 'KAS' }));

    expect(journal.lines).toHaveLength(1);
    expect(journal.lines[0]?.accountCode).toBe('1110');
    expect(journal.total).toBe(1);
  });

  it('(b) q filters by accountCode substring', async () => {
    invoices.findPaidInPeriod.mockResolvedValue([
      paidInvoice({ id: 'inv-b2', invoiceNo: 'INV-B2', amount: 150_000, taxAmount: 15_000 }),
    ]);
    // Lines: 1110, 4100, 2130 — searching "21" matches only 2130
    const journal = await service.getJournal(filter({ q: '21' }));

    expect(journal.lines).toHaveLength(1);
    expect(journal.lines[0]?.accountCode).toBe('2130');
    expect(journal.total).toBe(1);
  });

  it('(b) q filters by description substring', async () => {
    invoices.findPaidInPeriod.mockResolvedValue([
      paidInvoice({ id: 'inv-b3', invoiceNo: 'INV-B3', amount: 200_000 }),
    ]);
    // Description for debit line: "Pelunasan INV-B3 - Budi"
    const journal = await service.getJournal(filter({ q: 'pelunasan' }));

    expect(journal.lines).toHaveLength(1);
    expect(journal.lines[0]?.accountCode).toBe('1110');
    expect(journal.total).toBe(1);
  });

  // -------------------------------------------------------------------------
  // (c) CRITICAL: totals are UNCHANGED by q (full-period invariant)
  // -------------------------------------------------------------------------

  it('(c) totals are UNCHANGED by q — search subset never breaks balance', async () => {
    invoices.findPaidInPeriod.mockResolvedValue([
      paidInvoice({
        id: 'inv-c1',
        invoiceNo: 'INV-C1',
        amount: 300_000,
        lateFee: 20_000,
        taxAmount: 30_000,
      }),
    ]);

    // Unfiltered baseline to capture the full-period totals
    const unfiltered = await service.getJournal(filter());
    const expectedTotals = unfiltered.totals;

    // Apply a q that matches only one line
    const filtered = await service.getJournal(filter({ q: 'KAS' }));

    // totals must be identical to the unfiltered run
    expect(filtered.totals).toEqual(expectedTotals);
    // And the period must still balance (debit == credit)
    expect(filtered.totals.debit).toBe(filtered.totals.credit);
    // But lines is a strict subset
    expect(filtered.lines.length).toBeLessThan(unfiltered.lines.length);
  });

  // -------------------------------------------------------------------------
  // (d) sort by debit asc/desc reorders lines
  // -------------------------------------------------------------------------

  it('(d) sort by debit asc produces ascending debit values', async () => {
    invoices.findPaidInPeriod.mockResolvedValue([
      paidInvoice({ id: 'inv-d1', invoiceNo: 'INV-D1', amount: 300_000 }),
      paidInvoice({ id: 'inv-d2', invoiceNo: 'INV-D2', amount: 100_000 }),
    ]);
    const journal = await service.getJournal(filter({ sort: 'debit', order: 'asc' }));

    const debits = journal.lines.map((l) => l.debit);
    const sorted = [...debits].sort((a, b) => a - b);
    expect(debits).toEqual(sorted);
  });

  it('(d) sort by debit desc produces descending debit values', async () => {
    invoices.findPaidInPeriod.mockResolvedValue([
      paidInvoice({ id: 'inv-d3', invoiceNo: 'INV-D3', amount: 100_000 }),
      paidInvoice({ id: 'inv-d4', invoiceNo: 'INV-D4', amount: 500_000 }),
    ]);
    const journal = await service.getJournal(filter({ sort: 'debit', order: 'desc' }));

    const debits = journal.lines.map((l) => l.debit);
    const sortedDesc = [...debits].sort((a, b) => b - a);
    expect(debits).toEqual(sortedDesc);
  });

  // -------------------------------------------------------------------------
  // (e) unknown sort key falls back to default (natural) order
  // -------------------------------------------------------------------------

  it('(e) unknown sort key falls back to natural posting order', async () => {
    invoices.findPaidInPeriod.mockResolvedValue([
      paidInvoice({ id: 'inv-e1', invoiceNo: 'INV-E1', amount: 200_000 }),
    ]);
    const natural = await service.getJournal(filter());
    const withBadSort = await service.getJournal(filter({ sort: 'nonExistentField' }));

    // Same line IDs in same order
    expect(withBadSort.lines.map((l) => l.id)).toEqual(natural.lines.map((l) => l.id));
  });

  // -------------------------------------------------------------------------
  // (f) limit/offset paginate lines while total and totals stay full
  // -------------------------------------------------------------------------

  it('(f) limit/offset paginates lines; total and totals reflect the full period', async () => {
    // Two invoices each with lateFee → 3 lines each → 6 total lines
    invoices.findPaidInPeriod.mockResolvedValue([
      paidInvoice({ id: 'inv-f1', invoiceNo: 'INV-F1', amount: 200_000, lateFee: 10_000 }),
      paidInvoice({ id: 'inv-f2', invoiceNo: 'INV-F2', amount: 150_000, lateFee: 5_000 }),
    ]);

    const page1 = await service.getJournal(filter({ limit: 2, offset: 0 }));
    const page2 = await service.getJournal(filter({ limit: 2, offset: 2 }));
    const page3 = await service.getJournal(filter({ limit: 2, offset: 4 }));

    // total and totals are the same across all pages
    expect(page1.total).toBe(6);
    expect(page2.total).toBe(6);
    expect(page3.total).toBe(6);
    expect(page1.totals).toEqual(page2.totals);
    expect(page2.totals).toEqual(page3.totals);

    // Each page contains at most `limit` lines
    expect(page1.lines).toHaveLength(2);
    expect(page2.lines).toHaveLength(2);
    expect(page3.lines).toHaveLength(2);

    // All 6 lines covered without overlap
    const allIds = [...page1.lines, ...page2.lines, ...page3.lines].map((l) => l.id);
    expect(new Set(allIds).size).toBe(6);
  });

  // -------------------------------------------------------------------------
  // (g) balanced period reports debit == credit
  // -------------------------------------------------------------------------

  it('(g) a balanced period always reports totals.debit === totals.credit', async () => {
    invoices.findPaidInPeriod.mockResolvedValue([
      paidInvoice({
        id: 'inv-g1',
        invoiceNo: 'INV-G1',
        amount: 400_000,
        lateFee: 30_000,
        taxAmount: 40_000,
      }),
      paidInvoice({ id: 'inv-g2', invoiceNo: 'INV-G2', amount: 250_000 }),
    ]);
    const journal = await service.getJournal(filter());

    expect(journal.totals.debit).toBe(journal.totals.credit);
    expect(journal.totals.debit).toBeGreaterThan(0);
  });
});
