import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkOrder } from '../../infrastructure/database/schema/work-orders.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { InventoryService } from '../inventory/inventory.service';
import { InvoicesService } from '../invoices/invoices.service';
import { ProfilesRepository } from '../router-resources/profiles.repository';
import { SecretsRepository } from '../router-resources/secrets.repository';
import { RoutersRepository } from '../routers/routers.repository';
import { TicketsService } from '../tickets/tickets.service';
import { WorkOrdersRepository } from './work-orders.repository';
import { WorkOrdersService } from './work-orders.service';

const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c1';

const AUTHOR = 'Teknisi Budi';

const installWo: WorkOrder = {
  id: '00000000-0000-0000-0000-00000000a001',
  code: 'WO-9001',
  type: 'install',
  customerId: CUSTOMER_ID,
  customerName: 'Budi Santoso',
  technician: 'Teknisi Budi',
  scheduledAt: new Date('2026-06-16T00:00:00.000Z'),
  status: 'scheduled',
  ticketId: null,
  scannedOnuSerial: null,
  measuredRxPower: null,
  photos: null,
  signatureUrl: null,
  gpsLat: null,
  gpsLng: null,
  completedAt: null,
  completedBy: null,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

// A repair WO spawned from a ticket — completing it closes the loop (P3.B.4).
const repairWo: WorkOrder = {
  ...installWo,
  id: '00000000-0000-0000-0000-00000000a002',
  code: 'WO-9002',
  type: 'repair',
  ticketId: '00000000-0000-0000-0000-0000000000t1',
};

const customerRow = {
  id: CUSTOMER_ID,
  customerNo: 'CUST-9001',
  fullName: 'Budi Santoso',
  planName: 'Home 20',
};

// Completion evidence columns when no field-completion body was submitted
// (P3.B.3) — completedAt/completedBy are always set, the rest stay null.
const noFieldEvidence = {
  scannedOnuSerial: null,
  measuredRxPower: null,
  photos: null,
  signatureUrl: null,
  gpsLat: null,
  gpsLng: null,
  completedBy: AUTHOR,
};

describe('WorkOrdersService', () => {
  let service: WorkOrdersService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: Record<string, ReturnType<typeof vi.fn>>;
  let invoices: { generateFirstInvoice: ReturnType<typeof vi.fn> };
  let inventory: Record<string, ReturnType<typeof vi.fn>>;
  let routers: Record<string, ReturnType<typeof vi.fn>>;
  let profiles: { listByRouter: ReturnType<typeof vi.fn> };
  let secrets: { create: ReturnType<typeof vi.fn> };
  let tickets: { resolveFromWorkOrder: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      markDone: vi.fn(),
      patch: vi.fn(),
    };
    customers = { findById: vi.fn(), markInstalled: vi.fn() };
    invoices = { generateFirstInvoice: vi.fn() };
    // Defaults describe the fully-stocked happy path; degradation tests
    // override individual seams.
    inventory = {
      findAvailableOnu: vi.fn().mockResolvedValue({
        id: 'onu-1',
        serial: 'ZTEGREAL001',
        kind: 'onu',
        status: 'warehouse',
      }),
      findBySerial: vi.fn(),
      move: vi.fn(),
    };
    routers = {
      findFirst: vi.fn().mockResolvedValue({ id: 'rtr-1' }),
      adjustSecretCount: vi.fn(),
    };
    profiles = {
      listByRouter: vi.fn().mockResolvedValue({
        items: [{ id: 'prof-1', name: 'Home 20' }],
        total: 1,
      }),
    };
    secrets = { create: vi.fn() };
    tickets = { resolveFromWorkOrder: vi.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WorkOrdersService,
        { provide: WorkOrdersRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
        { provide: InvoicesService, useValue: invoices },
        { provide: InventoryService, useValue: inventory },
        { provide: RoutersRepository, useValue: routers },
        { provide: ProfilesRepository, useValue: profiles },
        { provide: SecretsRepository, useValue: secrets },
        { provide: TicketsService, useValue: tickets },
      ],
    }).compile();
    service = moduleRef.get(WorkOrdersService);
  });

  describe('complete', () => {
    it('runs the full install cascade: ONU + connection + secret + first invoice, then done', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });

      const result = await service.complete(installWo.id, AUTHOR);

      // ONU consumed from warehouse and assigned to the subscriber, with the
      // movement linked back to this work order (ADR-0003/0009).
      expect(inventory.move).toHaveBeenCalledWith('onu-1', {
        type: 'assign',
        note: 'Budi Santoso',
        workOrderId: installWo.id,
      });
      // Connection carries the real ONU serial (not the synthetic fallback).
      expect(customers.markInstalled).toHaveBeenCalledTimes(1);
      const [, connection] = customers.markInstalled.mock.calls[0] ?? [];
      expect(connection).toMatchObject({
        type: 'gpon',
        pppoeUsername: 'cust9001',
        profile: 'Home 20',
        onuSerial: 'ZTEGREAL001',
      });
      // PPPoE secret provisioned on the default router with the plan profile.
      expect(secrets.create).toHaveBeenCalledWith(
        expect.objectContaining({
          routerId: 'rtr-1',
          username: 'cust9001',
          profileId: 'prof-1',
          profileName: 'Home 20',
          customerId: CUSTOMER_ID,
          customerName: 'Budi Santoso',
        }),
      );
      expect(routers.adjustSecretCount).toHaveBeenCalledWith('rtr-1', 1);
      expect(invoices.generateFirstInvoice).toHaveBeenCalledWith(CUSTOMER_ID);
      // No field-completion body was submitted — evidence columns are null,
      // but completedAt/completedBy are always recorded.
      expect(repo.markDone).toHaveBeenCalledWith(
        installWo.id,
        expect.objectContaining({ ...noFieldEvidence, completedAt: expect.any(Date) }),
      );
      expect(result.status).toBe('done');
    });

    it('falls back to a synthetic ONU serial when warehouse stock is dry', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      inventory.findAvailableOnu.mockResolvedValue(null);
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });

      await service.complete(installWo.id, AUTHOR);

      expect(inventory.move).not.toHaveBeenCalled();
      const [, connection] = customers.markInstalled.mock.calls[0] ?? [];
      expect(connection.onuSerial).toBe('ZTEG20009001');
      // The customer is still activated and billed.
      expect(invoices.generateFirstInvoice).toHaveBeenCalledWith(CUSTOMER_ID);
    });

    it('falls back to the first profile when none matches the plan name', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      profiles.listByRouter.mockResolvedValue({
        items: [{ id: 'prof-default', name: 'default' }],
        total: 1,
      });
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });

      await service.complete(installWo.id, AUTHOR);

      expect(secrets.create).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: 'prof-default', profileName: 'default' }),
      );
    });

    it('skips the PPPoE secret when no router exists (still activates + bills)', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      routers.findFirst.mockResolvedValue(null);
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });

      await service.complete(installWo.id, AUTHOR);

      expect(secrets.create).not.toHaveBeenCalled();
      expect(routers.adjustSecretCount).not.toHaveBeenCalled();
      expect(customers.markInstalled).toHaveBeenCalledTimes(1);
      expect(invoices.generateFirstInvoice).toHaveBeenCalledWith(CUSTOMER_ID);
      expect(repo.markDone).toHaveBeenCalled();
    });

    it('is idempotent for an already-done order (no re-provisioning)', async () => {
      repo.findById.mockResolvedValue({ ...installWo, status: 'done' });
      const result = await service.complete(installWo.id, AUTHOR);
      expect(inventory.findAvailableOnu).not.toHaveBeenCalled();
      expect(customers.markInstalled).not.toHaveBeenCalled();
      expect(secrets.create).not.toHaveBeenCalled();
      expect(invoices.generateFirstInvoice).not.toHaveBeenCalled();
      expect(repo.markDone).not.toHaveBeenCalled();
      expect(result.status).toBe('done');
    });

    it('does not provision for a non-install order', async () => {
      repo.findById.mockResolvedValue({ ...installWo, type: 'repair' });
      repo.markDone.mockResolvedValue({
        ...installWo,
        type: 'repair',
        status: 'done',
      });
      await service.complete(installWo.id, AUTHOR);
      expect(inventory.findAvailableOnu).not.toHaveBeenCalled();
      expect(customers.markInstalled).not.toHaveBeenCalled();
      expect(secrets.create).not.toHaveBeenCalled();
      expect(invoices.generateFirstInvoice).not.toHaveBeenCalled();
      expect(repo.markDone).toHaveBeenCalled();
    });

    it('throws 404 for a missing order', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.complete('missing', AUTHOR)).rejects.toBeInstanceOf(NotFoundException);
    });

    // ADR-0009: an install order with no subscriber must fail loud rather than
    // silently skip the activation cascade (the old lead-convert break).
    it('rejects completing an install order with no linked customer', async () => {
      repo.findById.mockResolvedValue({ ...installWo, customerId: null });
      await expect(service.complete(installWo.id, AUTHOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo.markDone).not.toHaveBeenCalled();
    });

    // P3.B.4: completing a repair WO closes the linked ticket.
    it('resolves the linked ticket when a repair order is completed', async () => {
      repo.findById.mockResolvedValue(repairWo);
      repo.markDone.mockResolvedValue({ ...repairWo, status: 'done' });

      await service.complete(repairWo.id, AUTHOR);

      expect(tickets.resolveFromWorkOrder).toHaveBeenCalledWith(
        repairWo.ticketId,
        repairWo.code,
        AUTHOR,
      );
      // Repair path never touches the install cascade.
      expect(customers.markInstalled).not.toHaveBeenCalled();
      expect(invoices.generateFirstInvoice).not.toHaveBeenCalled();
    });

    it('does not touch tickets for a repair order with no linked ticket', async () => {
      repo.findById.mockResolvedValue({ ...repairWo, ticketId: null });
      repo.markDone.mockResolvedValue({ ...repairWo, ticketId: null, status: 'done' });

      await service.complete(repairWo.id, AUTHOR);

      expect(tickets.resolveFromWorkOrder).not.toHaveBeenCalled();
    });
  });

  describe('complete — field-completion evidence (P3.B.3)', () => {
    it('feeds the scanned serial + measured RX into the connection and persists the evidence', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      inventory.findBySerial.mockResolvedValue({
        id: 'onu-scanned',
        serial: 'ONU-SCAN-777',
        kind: 'onu',
        status: 'warehouse',
      });
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });

      const body = {
        onuSerial: 'ONU-SCAN-777',
        rxPower: -18.5,
        photos: ['https://cdn.example.com/a.jpg'],
        signatureUrl: 'https://cdn.example.com/sig.png',
        gps: { lat: -6.2, lng: 106.8 },
      };
      await service.complete(installWo.id, AUTHOR, body);

      // The scanned serial (not the FIFO pick) is consumed from stock.
      expect(inventory.findAvailableOnu).not.toHaveBeenCalled();
      expect(inventory.move).toHaveBeenCalledWith('onu-scanned', {
        type: 'assign',
        note: 'Budi Santoso',
        workOrderId: installWo.id,
      });
      const [, connection] = customers.markInstalled.mock.calls[0] ?? [];
      expect(connection).toMatchObject({ onuSerial: 'ONU-SCAN-777', rxPower: -18.5 });

      // Evidence lands on the same markDone update.
      expect(repo.markDone).toHaveBeenCalledWith(
        installWo.id,
        expect.objectContaining({
          scannedOnuSerial: 'ONU-SCAN-777',
          measuredRxPower: -18.5,
          photos: body.photos,
          signatureUrl: body.signatureUrl,
          gpsLat: body.gps.lat,
          gpsLng: body.gps.lng,
          completedBy: AUTHOR,
          completedAt: expect.any(Date),
        }),
      );
    });

    it('uses the scanned serial as-is when it is not in warehouse stock (no fabricated fallback)', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      inventory.findBySerial.mockResolvedValue(null);
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });

      await service.complete(installWo.id, AUTHOR, { onuSerial: 'ONU-UNKNOWN-9' });

      expect(inventory.move).not.toHaveBeenCalled();
      const [, connection] = customers.markInstalled.mock.calls[0] ?? [];
      expect(connection.onuSerial).toBe('ONU-UNKNOWN-9');
      expect(repo.markDone).toHaveBeenCalledWith(
        installWo.id,
        expect.objectContaining({ scannedOnuSerial: 'ONU-UNKNOWN-9' }),
      );
    });

    it('preserves the deterministic fallback when no completion body is given', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });

      await service.complete(installWo.id, AUTHOR);

      const [, connection] = customers.markInstalled.mock.calls[0] ?? [];
      expect(connection).toMatchObject({ onuSerial: 'ZTEGREAL001', rxPower: -20 - (9001 % 6) });
      expect(repo.markDone).toHaveBeenCalledWith(
        installWo.id,
        expect.objectContaining({ ...noFieldEvidence, completedAt: expect.any(Date) }),
      );
    });
  });

  describe('list', () => {
    const makeWo = (over: Partial<typeof installWo> = {}) => ({ ...installWo, ...over });

    it('delegates filter to the repo and maps items to WorkOrderResponse', async () => {
      const filter = { limit: 10, offset: 0 };
      repo.list.mockResolvedValue({ items: [installWo], total: 1 });

      const result = await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ id: installWo.id, code: installWo.code });
    });

    it('passes q and status filter through to the repo', async () => {
      const filter = { q: 'budi', status: 'scheduled' as const, limit: 50, offset: 0 };
      repo.list.mockResolvedValue({ items: [], total: 0 });

      await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
    });

    it('passes type filter through to the repo', async () => {
      const filter = { type: 'repair' as const, limit: 50, offset: 0 };
      repo.list.mockResolvedValue({ items: [], total: 0 });

      await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
    });

    it('passes sort and order through to the repo', async () => {
      const filter = { sort: 'code', order: 'asc' as const, limit: 50, offset: 0 };
      repo.list.mockResolvedValue({ items: [makeWo()], total: 1 });

      const result = await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
      expect(result.total).toBe(1);
    });

    it('returns empty items when repo returns empty', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0 });

      const result = await service.list({ limit: 50, offset: 0 });

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('createFromTicket', () => {
    it('creates a scheduled repair order', async () => {
      repo.create.mockResolvedValue({
        ...installWo,
        type: 'repair',
        technician: null,
      });
      const result = await service.createFromTicket({
        ticketId: '00000000-0000-0000-0000-0000000000t1',
        customerId: CUSTOMER_ID,
        customerName: 'Budi Santoso',
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'repair',
          customerId: CUSTOMER_ID,
          technician: null,
          ticketId: '00000000-0000-0000-0000-0000000000t1',
        }),
      );
      expect(result.type).toBe('repair');
    });
  });

  describe('scheduleInstallForCustomer', () => {
    it('creates an install order linked to the customer with the chosen schedule', async () => {
      repo.create.mockResolvedValue(installWo);
      const scheduledAt = new Date('2026-06-20T00:00:00.000Z');

      const result = await service.scheduleInstallForCustomer({
        customerId: CUSTOMER_ID,
        customerName: 'Budi Santoso',
        technician: 'Teknisi Andi',
        scheduledAt,
      });

      expect(repo.create).toHaveBeenCalledWith({
        type: 'install',
        customerId: CUSTOMER_ID,
        customerName: 'Budi Santoso',
        technician: 'Teknisi Andi',
        scheduledAt,
      });
      expect(result.type).toBe('install');
    });
  });

  describe('state machine (P3.B.2)', () => {
    const scheduled = {
      id: 'wo-1',
      code: 'WO-9001',
      type: 'repair',
      customerId: 'cust-1',
      customerName: 'Budi',
      technician: null,
      scheduledAt: new Date('2026-06-20T00:00:00.000Z'),
      status: 'scheduled',
      createdAt: new Date('2026-06-15T00:00:00.000Z'),
    };

    it('start: scheduled → in_progress', async () => {
      repo.findById.mockResolvedValue(scheduled);
      repo.patch.mockResolvedValue({ ...scheduled, status: 'in_progress' });
      const result = await service.start('wo-1');
      expect(repo.patch).toHaveBeenCalledWith('wo-1', { status: 'in_progress' });
      expect(result.status).toBe('in_progress');
    });

    it('start: rejects a done order', async () => {
      repo.findById.mockResolvedValue({ ...scheduled, status: 'done' });
      await expect(service.start('wo-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.patch).not.toHaveBeenCalled();
    });

    it('cancel: in_progress → cancelled', async () => {
      repo.findById.mockResolvedValue({ ...scheduled, status: 'in_progress' });
      repo.patch.mockResolvedValue({ ...scheduled, status: 'cancelled' });
      const result = await service.cancel('wo-1');
      expect(repo.patch).toHaveBeenCalledWith('wo-1', { status: 'cancelled' });
      expect(result.status).toBe('cancelled');
    });

    it('cancel: rejects a completed order', async () => {
      repo.findById.mockResolvedValue({ ...scheduled, status: 'done' });
      await expect(service.cancel('wo-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('assign: sets the technician on an open order', async () => {
      repo.findById.mockResolvedValue(scheduled);
      repo.patch.mockResolvedValue({ ...scheduled, technician: 'Teknisi Andi' });
      await service.assign('wo-1', 'Teknisi Andi');
      expect(repo.patch).toHaveBeenCalledWith('wo-1', { technician: 'Teknisi Andi' });
    });

    it('reschedule: rejects a cancelled order', async () => {
      repo.findById.mockResolvedValue({ ...scheduled, status: 'cancelled' });
      await expect(service.reschedule('wo-1', new Date())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('404 for a missing order', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.start('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
