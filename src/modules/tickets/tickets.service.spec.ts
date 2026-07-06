import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ticket } from '../../infrastructure/database/schema/tickets.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { WorkOrdersService } from '../work-orders/work-orders.service';
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
  category: null,
  photoUrl: null,
  csatRating: null,
  csatComment: null,
  csatAt: null,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('TicketsService', () => {
  let service: TicketsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: { findIdByFullName: ReturnType<typeof vi.fn>; findById: ReturnType<typeof vi.fn> };
  let workOrders: { createFromTicket: ReturnType<typeof vi.fn> };
  let notifications: { enqueue: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      findByIdForCustomer: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      submitCsat: vi.fn(),
      addEvent: vi.fn(),
      listEvents: vi.fn(),
      markBreachedPastSla: vi.fn(),
    };
    customers = { findIdByFullName: vi.fn(), findById: vi.fn() };
    workOrders = { createFromTicket: vi.fn() };
    notifications = { enqueue: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: TicketsRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
        { provide: WorkOrdersService, useValue: workOrders },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = moduleRef.get(TicketsService);
  });

  describe('list', () => {
    it('forwards the filter to the repo and maps rows', async () => {
      repo.list.mockResolvedValue({ items: [baseTicket], total: 1 });
      const result = await service.list({ limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith({ limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({ code: 'TKT-2001' });
    });

    it('passes q filter through to the repo', async () => {
      const filter = { q: 'Internet', limit: 50, offset: 0 };
      repo.list.mockResolvedValue({ items: [baseTicket], total: 1 });

      const result = await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
      expect(result.total).toBe(1);
    });

    it('passes q + status composed filter through to the repo', async () => {
      const filter = { q: 'Budi', status: 'open' as const, limit: 50, offset: 0 };
      repo.list.mockResolvedValue({ items: [baseTicket], total: 1 });

      await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
    });

    it('passes sort and order asc through to the repo', async () => {
      const filter = { sort: 'createdAt', order: 'asc' as const, limit: 50, offset: 0 };
      repo.list.mockResolvedValue({ items: [baseTicket], total: 1 });

      const result = await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
      expect(result.total).toBe(1);
    });

    it('passes sort desc through to the repo', async () => {
      const filter = { sort: 'priority', order: 'desc' as const, limit: 50, offset: 0 };
      repo.list.mockResolvedValue({ items: [], total: 0 });

      await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
    });

    it('returns empty items when repo returns empty', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0 });
      const result = await service.list({ limit: 50, offset: 0 });
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });
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

    it('threads category and photoUrl through to the repo (portal report)', async () => {
      customers.findIdByFullName.mockResolvedValue(baseTicket.customerId);
      repo.create.mockResolvedValue({
        ...baseTicket,
        category: 'koneksi_putus',
        photoUrl: 'https://cdn.example.com/photo.jpg',
      });

      const result = await service.create(
        {
          subject: 'Internet mati',
          customerName: 'Budi Santoso',
          priority: 'high',
          category: 'koneksi_putus',
          photoUrl: 'https://cdn.example.com/photo.jpg',
        },
        AUTHOR,
      );

      const created = repo.create.mock.calls[0]?.[0];
      expect(created.category).toBe('koneksi_putus');
      expect(created.photoUrl).toBe('https://cdn.example.com/photo.jpg');
      expect(result.category).toBe('koneksi_putus');
      expect(result.photoUrl).toBe('https://cdn.example.com/photo.jpg');
    });

    it('defaults category/photoUrl to null when the caller omits them', async () => {
      customers.findIdByFullName.mockResolvedValue(baseTicket.customerId);
      repo.create.mockResolvedValue(baseTicket);

      await service.create(
        { subject: 'Internet mati', customerName: 'Budi Santoso', priority: 'high' },
        AUTHOR,
      );

      const created = repo.create.mock.calls[0]?.[0];
      expect(created.category).toBeNull();
      expect(created.photoUrl).toBeNull();
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
      // ADR-0012: an assignee-only change has no customer-facing template —
      // no ticket_update fires (status change is the only trigger chosen).
      expect(notifications.enqueue).not.toHaveBeenCalled();
    });

    it('records a status event and keeps resolved when within the deadline', async () => {
      repo.findById.mockResolvedValue(baseTicket);
      repo.update.mockResolvedValue({ ...baseTicket, status: 'resolved' });
      customers.findById.mockResolvedValue({ phone: '0812', fullName: 'Budi Santoso' });

      await service.update(baseTicket.id, { status: 'resolved' }, AUTHOR);

      expect(repo.update.mock.calls[0]?.[1].status).toBe('resolved');
      expect(repo.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'status', body: 'Status → resolved' }),
      );
      // ADR-0012: a status transition fires ticket_update to the owning customer.
      expect(customers.findById).toHaveBeenCalledWith(baseTicket.customerId);
      expect(notifications.enqueue).toHaveBeenCalledWith(
        { event: 'ticket_update', to: '0812', vars: { nama: 'Budi Santoso' } },
        `ticket_update:${baseTicket.id}:resolved`,
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

    it('skips the ticket_update notice when the ticket has no linked customer', async () => {
      const noCustomer = { ...baseTicket, customerId: null };
      repo.findById.mockResolvedValue(noCustomer);
      repo.update.mockResolvedValue({ ...noCustomer, status: 'resolved' });

      await service.update(noCustomer.id, { status: 'resolved' }, AUTHOR);

      expect(customers.findById).not.toHaveBeenCalled();
      expect(notifications.enqueue).not.toHaveBeenCalled();
    });

    it('does not fail the status update when the notification enqueue rejects (best-effort)', async () => {
      repo.findById.mockResolvedValue(baseTicket);
      repo.update.mockResolvedValue({ ...baseTicket, status: 'resolved' });
      customers.findById.mockResolvedValue({ phone: '0812', fullName: 'Budi Santoso' });
      notifications.enqueue.mockRejectedValue(new Error('queue down'));

      const result = await service.update(baseTicket.id, { status: 'resolved' }, AUTHOR);

      expect(result.status).toBe('resolved');
    });

    it('throws 404 for a missing ticket', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.update('missing', { subject: 'x' }, AUTHOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('resolveFromWorkOrder (P3.B.4)', () => {
    it('resolves an open ticket and appends a workorder + status event', async () => {
      repo.findById.mockResolvedValue(baseTicket);
      repo.update.mockResolvedValue({ ...baseTicket, status: 'resolved' });
      customers.findById.mockResolvedValue({ phone: '0812', fullName: 'Budi Santoso' });

      await service.resolveFromWorkOrder(baseTicket.id, 'WO-9002', AUTHOR);

      expect(repo.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'workorder', body: 'Perbaikan selesai — WO WO-9002' }),
      );
      expect(repo.update.mock.calls[0]?.[1].status).toBe('resolved');
      expect(repo.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'status', body: 'Status → resolved' }),
      );
      // ADR-0012: the repair-loop close is also a customer-facing transition.
      expect(notifications.enqueue).toHaveBeenCalledWith(
        { event: 'ticket_update', to: '0812', vars: { nama: 'Budi Santoso' } },
        `ticket_update:${baseTicket.id}:resolved`,
      );
    });

    it('records breached when the SLA deadline has already passed', async () => {
      const overdue = { ...baseTicket, slaDueAt: new Date('2020-01-01T00:00:00.000Z') };
      repo.findById.mockResolvedValue(overdue);
      repo.update.mockResolvedValue({ ...overdue, status: 'breached' });

      await service.resolveFromWorkOrder(overdue.id, 'WO-9002', AUTHOR);

      expect(repo.update.mock.calls[0]?.[1].status).toBe('breached');
    });

    it('is a no-op on an already-closed ticket (idempotent)', async () => {
      repo.findById.mockResolvedValue({ ...baseTicket, status: 'resolved' });

      await service.resolveFromWorkOrder(baseTicket.id, 'WO-9002', AUTHOR);

      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.addEvent).not.toHaveBeenCalled();
    });

    it('throws 404 for a missing ticket', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(
        service.resolveFromWorkOrder('missing', 'WO-9002', AUTHOR),
      ).rejects.toBeInstanceOf(NotFoundException);
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

  describe('createWorkOrder', () => {
    it('dispatches a repair work order and logs a workorder event', async () => {
      repo.findById.mockResolvedValue(baseTicket);
      workOrders.createFromTicket.mockResolvedValue({ code: 'WO-9001' });

      const wo = await service.createWorkOrder(baseTicket.id, AUTHOR);

      expect(workOrders.createFromTicket).toHaveBeenCalledWith({
        ticketId: baseTicket.id,
        customerId: baseTicket.customerId,
        customerName: baseTicket.customerName,
      });
      expect(repo.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'workorder',
          body: 'Work order WO-9001 dibuat',
        }),
      );
      expect(wo.code).toBe('WO-9001');
    });

    it('throws 404 for a missing ticket', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.createWorkOrder('missing', AUTHOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('submitCsat (P3.C.2)', () => {
    it('422s when the ticket is not resolved/breached', async () => {
      repo.findById.mockResolvedValue({ ...baseTicket, status: 'open' });
      await expect(
        service.submitCsat(baseTicket.id, { rating: 5, comment: null }, AUTHOR),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repo.submitCsat).not.toHaveBeenCalled();
    });

    it('persists the rating and records a csat timeline event on a resolved ticket', async () => {
      const resolved = { ...baseTicket, status: 'resolved' as const };
      repo.findById.mockResolvedValue(resolved);
      repo.submitCsat.mockResolvedValue({
        ...resolved,
        csatRating: 5,
        csatComment: 'Puas',
        csatAt: new Date('2026-07-06T00:00:00.000Z'),
      });

      const result = await service.submitCsat(
        baseTicket.id,
        { rating: 5, comment: 'Puas' },
        AUTHOR,
      );

      expect(repo.submitCsat).toHaveBeenCalledWith(baseTicket.id, { rating: 5, comment: 'Puas' });
      expect(repo.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'csat', author: AUTHOR }),
      );
      expect(result.csatRating).toBe(5);
      expect(result.csatComment).toBe('Puas');
    });

    it('allows rating a breached ticket too', async () => {
      const breached = { ...baseTicket, status: 'breached' as const };
      repo.findById.mockResolvedValue(breached);
      repo.submitCsat.mockResolvedValue({ ...breached, csatRating: 2, csatComment: null });

      const result = await service.submitCsat(baseTicket.id, { rating: 2, comment: null }, AUTHOR);
      expect(result.csatRating).toBe(2);
    });

    it('throws 404 for a missing ticket', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(
        service.submitCsat('missing', { rating: 4, comment: null }, AUTHOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('findByIdForCustomer (P3.C.2)', () => {
    it('returns the mapped ticket when it belongs to the customer', async () => {
      repo.findByIdForCustomer.mockResolvedValue(baseTicket);
      const result = await service.findByIdForCustomer(baseTicket.id, baseTicket.customerId ?? '');
      expect(repo.findByIdForCustomer).toHaveBeenCalledWith(
        baseTicket.id,
        baseTicket.customerId ?? '',
      );
      expect(result?.id).toBe(baseTicket.id);
    });

    it('returns null when the ticket belongs to another customer', async () => {
      repo.findByIdForCustomer.mockResolvedValue(null);
      const result = await service.findByIdForCustomer(baseTicket.id, 'someone-else');
      expect(result).toBeNull();
    });
  });

  describe('scanSla (P2.1)', () => {
    it('marks overdue tickets breached and records an escalation event each', async () => {
      repo.markBreachedPastSla.mockResolvedValue([{ id: 't-1' }, { id: 't-2' }]);

      const result = await service.scanSla();

      expect(result).toEqual({ breached: 2 });
      expect(repo.addEvent).toHaveBeenCalledTimes(2);
      expect(repo.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 't-1', kind: 'status', author: 'Sistem' }),
      );
    });

    it('does nothing when no ticket is overdue', async () => {
      repo.markBreachedPastSla.mockResolvedValue([]);
      const result = await service.scanSla();
      expect(result).toEqual({ breached: 0 });
      expect(repo.addEvent).not.toHaveBeenCalled();
    });
  });
});
