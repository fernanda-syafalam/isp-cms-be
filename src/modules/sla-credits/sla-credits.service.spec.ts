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
  appliedAt: null,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('SlaCreditsService', () => {
  let service: SlaCreditsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: { findIdByFullName: ReturnType<typeof vi.fn> };
  let tickets: { findIdByCode: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = { list: vi.fn(), findById: vi.fn(), create: vi.fn(), apply: vi.fn(), void: vi.fn() };
    customers = { findIdByFullName: vi.fn() };
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
    it('applies a pending credit', async () => {
      repo.findById.mockResolvedValue(credit);
      repo.apply.mockResolvedValue({
        ...credit,
        status: 'applied',
        appliedAt: new Date('2026-06-15T10:00:00.000Z'),
      });
      const result = await service.apply(credit.id);
      expect(repo.apply).toHaveBeenCalledWith(credit.id);
      expect(result.status).toBe('applied');
      expect(result.appliedAt).toBe('2026-06-15T10:00:00.000Z');
    });

    it('is idempotent for an already-applied credit', async () => {
      repo.findById.mockResolvedValue({ ...credit, status: 'applied' });
      await service.apply(credit.id);
      expect(repo.apply).not.toHaveBeenCalled();
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
