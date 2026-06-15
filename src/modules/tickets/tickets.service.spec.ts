import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ticket } from '../../infrastructure/database/schema/tickets.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { TicketsRepository } from './tickets.repository';
import { TicketsService } from './tickets.service';

const AUTHOR = 'Agent Sari';

const baseTicket: Ticket = {
  id: '00000000-0000-0000-0000-0000000000d1',
  code: 'TKT-2001',
  subject: 'Internet mati',
  customerId: '00000000-0000-0000-0000-0000000000c1',
  customerName: 'Budi Santoso',
  priority: 'high',
  status: 'open',
  assignee: null,
  // Far future deadline by default so 'resolved' stays 'resolved'.
  slaDueAt: new Date('2999-01-01T00:00:00.000Z'),
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('TicketsService', () => {
  let service: TicketsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: { findIdByFullName: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      addEvent: vi.fn(),
      listEvents: vi.fn(),
    };
    customers = { findIdByFullName: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: TicketsRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
      ],
    }).compile();
    service = moduleRef.get(TicketsService);
  });

  describe('create', () => {
    it('resolves the customer id by name, computes the SLA deadline, and logs a created event', async () => {
      customers.findIdByFullName.mockResolvedValue(baseTicket.customerId);
      repo.create.mockResolvedValue(baseTicket);

      const result = await service.create(
        {
          subject: 'Internet mati',
          customerName: 'Budi Santoso',
          priority: 'high',
        },
        AUTHOR,
      );

      expect(customers.findIdByFullName).toHaveBeenCalledWith('Budi Santoso');
      const created = repo.create.mock.calls[0]?.[0];
      // high priority -> 8h after createdAt
      expect(created.customerId).toBe(baseTicket.customerId);
      expect(created.slaDueAt.getTime() - created.createdAt.getTime()).toBe(8 * 3_600_000);
      expect(repo.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'created', author: AUTHOR }),
      );
      expect(result.code).toBe('TKT-2001');
    });

    it('leaves customerId null when no subscriber matches the name', async () => {
      customers.findIdByFullName.mockResolvedValue(null);
      repo.create.mockResolvedValue({ ...baseTicket, customerId: null });
      const result = await service.create(
        { subject: 'X', customerName: 'Unknown', priority: 'low' },
        AUTHOR,
      );
      expect(result.customerId).toBeNull();
    });
  });

  describe('update', () => {
    it('recomputes the SLA deadline when priority changes', async () => {
      repo.findById.mockResolvedValue(baseTicket);
      repo.update.mockResolvedValue({ ...baseTicket, priority: 'urgent' });
      await service.update(baseTicket.id, { priority: 'urgent' }, AUTHOR);
      const patch = repo.update.mock.calls[0]?.[1];
      // urgent -> 4h after the original createdAt
      expect(patch.slaDueAt.getTime() - baseTicket.createdAt.getTime()).toBe(4 * 3_600_000);
    });

    it('appends an assign event only when the assignee changes', async () => {
      repo.findById.mockResolvedValue(baseTicket);
      repo.update.mockResolvedValue({
        ...baseTicket,
        assignee: 'Teknisi Budi',
      });
      await service.update(baseTicket.id, { assignee: 'Teknisi Budi' }, AUTHOR);
      expect(repo.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'assign',
          body: 'Ditugaskan ke Teknisi Budi',
        }),
      );
    });

    it('records a status event and keeps resolved when within the deadline', async () => {
      repo.findById.mockResolvedValue(baseTicket);
      repo.update.mockResolvedValue({ ...baseTicket, status: 'resolved' });
      await service.update(baseTicket.id, { status: 'resolved' }, AUTHOR);
      expect(repo.update.mock.calls[0]?.[1].status).toBe('resolved');
      expect(repo.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'status', body: 'Status → resolved' }),
      );
    });

    it('downgrades resolved to breached when the deadline has passed', async () => {
      const overdue = {
        ...baseTicket,
        slaDueAt: new Date('2020-01-01T00:00:00.000Z'),
      };
      repo.findById.mockResolvedValue(overdue);
      repo.update.mockResolvedValue({ ...overdue, status: 'breached' });
      await service.update(overdue.id, { status: 'resolved' }, AUTHOR);
      expect(repo.update.mock.calls[0]?.[1].status).toBe('breached');
      expect(repo.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'status', body: 'Status → breached' }),
      );
    });

    it('throws 404 for a missing ticket', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.update('missing', { subject: 'x' }, AUTHOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('addComment', () => {
    it('appends a comment event', async () => {
      repo.findById.mockResolvedValue(baseTicket);
      await service.addComment(baseTicket.id, { body: 'Sedang dicek' }, AUTHOR);
      expect(repo.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'comment',
          body: 'Sedang dicek',
          author: AUTHOR,
        }),
      );
    });

    it('throws 404 for a missing ticket', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.addComment('missing', { body: 'x' }, AUTHOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
