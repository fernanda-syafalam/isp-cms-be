import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlaCredit } from '../../infrastructure/database/schema/sla-credits.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { TicketsRepository } from '../tickets/tickets.repository';
import { SlaCreditsRepository } from './sla-credits.repository';
import { SlaCreditsService } from './sla-credits.service';

const credit: SlaCredit = {
  id: '00000000-0000-0000-0000-00000000d001',
  customerId: '00000000-0000-0000-0000-0000000000c1',
  customerName: 'Budi Santoso',
  amount: 50_000,
  reason: 'Gangguan 2 hari',
  ticketId: null,
  ticketCode: null,
  status: 'pending',
  appliedInvoiceId: null,
  appliedAt: null,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

// Default full-set summary returned by the mock repo
const defaultSummary = {
  total: 6,
  activeAmount: 150_000,
  pending: 3,
  applied: 2,
  void: 1,
};

describe('SlaCreditsService', () => {
  let service: SlaCreditsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: {
    findIdByFullName: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    setBilling: ReturnType<typeof vi.fn>;
  };
  let tickets: { findIdByCode: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      apply: vi.fn(),
      applyWithInvoiceCredit: vi.fn(),
      void: vi.fn(),
    };
    customers = { findIdByFullName: vi.fn(), findById: vi.fn(), setBilling: vi.fn() };
    tickets = { findIdByCode: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SlaCreditsService,
        { provide: SlaCreditsRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
        { provide: TicketsRepository, useValue: tickets },
      ],
    }).compile();
    service = moduleRef.get(SlaCreditsService);
  });

  // ---------------------------------------------------------------------------
  // list — pagination, search, sort, and summary invariant
  // ---------------------------------------------------------------------------

  describe('list', () => {
    it('maps credits, passes total through, and includes summary', async () => {
      repo.list.mockResolvedValue({ items: [credit], total: 1, summary: defaultSummary });
      const result = await service.list({ limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.customerName).toBe('Budi Santoso');
      expect(result.items[0]?.createdAt).toBe('2026-06-15T00:00:00.000Z');
      expect(result.items[0]?.appliedAt).toBeNull();
      expect(result.summary).toEqual(defaultSummary);
    });

    it('q search by customerName narrows total but summary stays invariant', async () => {
      const matched: SlaCredit = { ...credit, customerName: 'Ani Rahayu' };
      repo.list.mockResolvedValue({ items: [matched], total: 1, summary: defaultSummary });
      const result = await service.list({ q: 'Ani Rahayu', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'Ani Rahayu' }));
      expect(result.items[0]?.customerName).toBe('Ani Rahayu');
      expect(result.total).toBe(1);
      // Summary must reflect the full set, not just the filtered slice.
      expect(result.summary).toEqual(defaultSummary);
    });

    it('q search by reason narrows total but summary stays invariant', async () => {
      const matched: SlaCredit = { ...credit, reason: 'Gangguan jaringan' };
      repo.list.mockResolvedValue({ items: [matched], total: 1, summary: defaultSummary });
      const result = await service.list({ q: 'Gangguan', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'Gangguan' }));
      expect(result.total).toBe(1);
      expect(result.summary).toEqual(defaultSummary);
    });

    it('forwards sort asc to the repo', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0, summary: defaultSummary });
      await service.list({ sort: 'customerName', order: 'asc', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'customerName', order: 'asc' }),
      );
    });

    it('forwards sort desc to the repo', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0, summary: defaultSummary });
      await service.list({ sort: 'amount', order: 'desc', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'amount', order: 'desc' }),
      );
    });

    it('unknown sort key is forwarded to the repo (repo falls back to createdAt desc via buildOrderBy)', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0, summary: defaultSummary });
      await service.list({ sort: 'unknownField', order: 'asc', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ sort: 'unknownField' }));
    });

    it('limit/offset paging keeps total and summary unaffected', async () => {
      const page2Item: SlaCredit = {
        ...credit,
        id: '00000000-0000-0000-0000-00000000d099',
      };
      repo.list.mockResolvedValue({
        items: [page2Item],
        total: 30,
        summary: defaultSummary,
      });
      const result = await service.list({ limit: 10, offset: 10 });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, offset: 10 }));
      // total is full filtered count, not just page size
      expect(result.total).toBe(30);
      // summary is always full-set
      expect(result.summary).toEqual(defaultSummary);
    });

    it('summary activeAmount excludes void credits', async () => {
      const summaryWithVoid = {
        total: 2,
        activeAmount: 50_000, // only non-void credits counted
        pending: 1,
        applied: 0,
        void: 1,
      };
      repo.list.mockResolvedValue({ items: [], total: 0, summary: summaryWithVoid });
      const result = await service.list({ limit: 50, offset: 0 });
      expect(result.summary.activeAmount).toBe(50_000);
      expect(result.summary.pending).toBe(1);
      expect(result.summary.applied).toBe(0);
    });

    // ADR-0011 parity: total/void are passthrough from the repository's
    // grouped-filter aggregate — the service must not recompute or drop them.
    it('summary.total and summary.void pass through unchanged', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0, summary: defaultSummary });
      const result = await service.list({ limit: 50, offset: 0 });
      expect(result.summary.total).toBe(6);
      expect(result.summary.void).toBe(1);
    });
  });

  describe('create', () => {
    it('resolves the customer and ticket and keeps the ticket code when it resolves', async () => {
      customers.findIdByFullName.mockResolvedValue('cust-1');
      tickets.findIdByCode.mockResolvedValue('tkt-1');
      repo.create.mockResolvedValue({
        ...credit,
        customerId: 'cust-1',
        ticketId: 'tkt-1',
        ticketCode: 'TKT-2001',
      });

      await service.create({
        customerName: 'Budi Santoso',
        amount: 50_000,
        reason: 'Gangguan 2 hari',
        ticketCode: 'TKT-2001',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'cust-1',
          ticketId: 'tkt-1',
          ticketCode: 'TKT-2001',
        }),
      );
    });

    it('drops the ticket code when it does not resolve', async () => {
      customers.findIdByFullName.mockResolvedValue(null);
      tickets.findIdByCode.mockResolvedValue(null);
      repo.create.mockResolvedValue(credit);
      await service.create({
        customerName: 'Nobody',
        amount: 10_000,
        reason: 'x',
        ticketCode: 'TKT-9999',
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: null, ticketId: null, ticketCode: null }),
      );
    });
  });

  describe('apply', () => {
    // Regression (outstanding-integrity fix): a credit that resolves to a
    // customer is now applied via `applyWithInvoiceCredit` — a REAL
    // discount line on a real invoice, deducted + recomputed in ONE
    // transaction — never a hand-computed `customer.outstanding - amount`
    // write (that was the silent-wipe bug: `outstanding` is a DERIVED
    // column, recomputed from unpaid invoices on every billing event, so a
    // bare delta with no backing invoice row got silently erased by the
    // next recompute). `applyWithInvoiceCredit` itself (the invoice-line
    // math, the locking) is covered end-to-end in
    // `sla-credits.repository.int-spec.ts`; here we only assert the
    // service routes to the right repo method and never touches
    // `customers` directly.
    it('applies a pending credit that resolves to a customer via applyWithInvoiceCredit', async () => {
      repo.findById.mockResolvedValue(credit);
      repo.applyWithInvoiceCredit.mockResolvedValue({
        ...credit,
        status: 'applied',
        appliedInvoiceId: '00000000-0000-0000-0000-00000000e001',
        appliedAt: new Date('2026-06-15T10:00:00.000Z'),
      });
      const result = await service.apply(credit.id);
      expect(repo.applyWithInvoiceCredit).toHaveBeenCalledWith(credit.id, credit.customerId);
      expect(repo.apply).not.toHaveBeenCalled();
      // The service never reads or writes `customers` directly for this path
      // — the repository owns the invoice-line + outstanding transaction.
      expect(customers.findById).not.toHaveBeenCalled();
      expect(customers.setBilling).not.toHaveBeenCalled();
      expect(result.status).toBe('applied');
      expect(result.appliedAt).toBe('2026-06-15T10:00:00.000Z');
    });

    it('only transitions state (plain repo.apply) when the credit has no resolved customer', async () => {
      repo.findById.mockResolvedValue({ ...credit, customerId: null });
      repo.apply.mockResolvedValue({ ...credit, customerId: null, status: 'applied' });
      await service.apply(credit.id);
      expect(repo.apply).toHaveBeenCalledWith(credit.id);
      expect(repo.applyWithInvoiceCredit).not.toHaveBeenCalled();
      expect(customers.findById).not.toHaveBeenCalled();
      expect(customers.setBilling).not.toHaveBeenCalled();
    });

    it('is idempotent for an already-applied credit', async () => {
      repo.findById.mockResolvedValue({ ...credit, status: 'applied' });
      await service.apply(credit.id);
      expect(repo.apply).not.toHaveBeenCalled();
      expect(repo.applyWithInvoiceCredit).not.toHaveBeenCalled();
      expect(customers.setBilling).not.toHaveBeenCalled();
    });

    it('rejects applying a void credit', async () => {
      repo.findById.mockResolvedValue({ ...credit, status: 'void' });
      await expect(service.apply(credit.id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws 404 for a missing credit', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.apply('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('void', () => {
    it('voids a pending credit', async () => {
      repo.findById.mockResolvedValue(credit);
      repo.void.mockResolvedValue({ ...credit, status: 'void' });
      const result = await service.void(credit.id);
      expect(result.status).toBe('void');
    });

    it('rejects voiding an applied credit', async () => {
      repo.findById.mockResolvedValue({ ...credit, status: 'applied' });
      await expect(service.void(credit.id)).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
