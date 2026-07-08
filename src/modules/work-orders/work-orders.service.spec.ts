import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkOrder } from '../../infrastructure/database/schema/work-orders.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { InventoryService } from '../inventory/inventory.service';
import { InvoicesService } from '../invoices/invoices.service';
import { NotificationsService } from '../notifications/notifications.service';
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
  completionNotes: null,
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
  phone: '0812000001',
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
  completionNotes: null,
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
  let secrets: { create: ReturnType<typeof vi.fn>; findByCustomerId: ReturnType<typeof vi.fn> };
  let tickets: { resolveFromWorkOrder: ReturnType<typeof vi.fn> };
  let notifications: { enqueue: ReturnType<typeof vi.fn> };

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
    // No secret provisioned yet by default — the happy-path cascade inserts
    // one. Retry-idempotency tests override this to an already-existing row.
    secrets = { create: vi.fn(), findByCustomerId: vi.fn().mockResolvedValue(null) };
    tickets = { resolveFromWorkOrder: vi.fn() };
    notifications = { enqueue: vi.fn() };

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
        { provide: NotificationsService, useValue: notifications },
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

  describe('complete — install cascade retry idempotency', () => {
    // Simulates a retry of complete() after a mid-cascade failure (e.g.
    // generateFirstInvoice throwing on the first attempt, after the PPPoE
    // secret already committed). The WO only reaches `done` once the whole
    // cascade succeeds, so the top-level early-return on wo.status==='done'
    // does not protect this case — provisionSecret must guard itself.
    it('does not duplicate the PPPoE secret or double-count the router when provisionSecret runs twice for the same customer', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });

      // First attempt: no secret exists yet — cascade provisions one.
      secrets.findByCustomerId.mockResolvedValueOnce(null);
      await service.complete(installWo.id, AUTHOR);
      expect(secrets.create).toHaveBeenCalledTimes(1);
      expect(routers.adjustSecretCount).toHaveBeenCalledTimes(1);

      // Retry (e.g. invoice generation threw after the secret committed, and
      // the WO is still not 'done' so complete() re-enters the cascade):
      // findByCustomerId now reports the secret created on the first attempt.
      secrets.findByCustomerId.mockResolvedValueOnce({
        id: 'sec-1',
        customerId: CUSTOMER_ID,
      });
      await service.complete(installWo.id, AUTHOR);

      // No second insert, no second increment — exactly once each.
      expect(secrets.create).toHaveBeenCalledTimes(1);
      expect(routers.adjustSecretCount).toHaveBeenCalledTimes(1);
      // The rest of the cascade still re-runs on retry (activation + billing
      // are independently idempotent — see invoices.service.spec.ts).
      expect(invoices.generateFirstInvoice).toHaveBeenCalledTimes(2);
    });

    it('skips insert and adjustSecretCount when a secret already exists for the customer', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });
      secrets.findByCustomerId.mockResolvedValue({ id: 'sec-existing', customerId: CUSTOMER_ID });

      await service.complete(installWo.id, AUTHOR);

      expect(secrets.create).not.toHaveBeenCalled();
      expect(routers.adjustSecretCount).not.toHaveBeenCalled();
      // The rest of the cascade is unaffected.
      expect(customers.markInstalled).toHaveBeenCalledTimes(1);
      expect(invoices.generateFirstInvoice).toHaveBeenCalledWith(CUSTOMER_ID);
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

    // completion_notes (0045) — the "Catatan" free-text field the technician
    // enters on the completion form.
    it('persists the completion note and echoes it back on the completed order', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      repo.markDone.mockResolvedValue({
        ...installWo,
        status: 'done',
        completionNotes: 'ONT dipasang di lantai 2, sinyal stabil.',
      });

      const result = await service.complete(installWo.id, AUTHOR, {
        notes: 'ONT dipasang di lantai 2, sinyal stabil.',
      });

      expect(repo.markDone).toHaveBeenCalledWith(
        installWo.id,
        expect.objectContaining({ completionNotes: 'ONT dipasang di lantai 2, sinyal stabil.' }),
      );
      expect(result.completionNotes).toBe('ONT dipasang di lantai 2, sinyal stabil.');
    });

    it('leaves completionNotes null when the technician submits no note', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });

      const result = await service.complete(installWo.id, AUTHOR);

      expect(repo.markDone).toHaveBeenCalledWith(
        installWo.id,
        expect.objectContaining({ completionNotes: null }),
      );
      expect(result.completionNotes).toBeNull();
    });
  });

  describe('list', () => {
    const makeWo = (over: Partial<typeof installWo> = {}) => ({ ...installWo, ...over });

    // Full-set rollup the repo would return alongside a status-filtered page
    // — used to prove the service passes it through untouched (P3.B.5 /
    // FE contract parity).
    const fullSetSummary = {
      total: 4,
      byStatus: { scheduled: 1, in_progress: 1, done: 1, cancelled: 1 },
    };

    it('delegates filter to the repo and maps items to WorkOrderResponse', async () => {
      const filter = { limit: 10, offset: 0 };
      repo.list.mockResolvedValue({ items: [installWo], total: 1, summary: fullSetSummary });

      const result = await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ id: installWo.id, code: installWo.code });
    });

    it('passes q and status filter through to the repo', async () => {
      const filter = { q: 'budi', status: 'scheduled' as const, limit: 50, offset: 0 };
      repo.list.mockResolvedValue({ items: [], total: 0, summary: fullSetSummary });

      await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
    });

    it('passes type filter through to the repo', async () => {
      const filter = { type: 'repair' as const, limit: 50, offset: 0 };
      repo.list.mockResolvedValue({ items: [], total: 0, summary: fullSetSummary });

      await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
    });

    it('passes sort and order through to the repo', async () => {
      const filter = { sort: 'code', order: 'asc' as const, limit: 50, offset: 0 };
      repo.list.mockResolvedValue({ items: [makeWo()], total: 1, summary: fullSetSummary });

      const result = await service.list(filter);

      expect(repo.list).toHaveBeenCalledWith(filter);
      expect(result.total).toBe(1);
    });

    it('returns empty items when repo returns empty', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0, summary: fullSetSummary });

      const result = await service.list({ limit: 50, offset: 0 });

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    // T1 — FE contract parity: the list response must carry the full-set
    // byStatus rollup regardless of the page's status filter (dashboard
    // KPI/tab counts must not shrink when the caller narrows the page).
    it('passes the repo summary through unchanged, independent of the status filter', async () => {
      repo.list.mockResolvedValue({
        items: [installWo],
        total: 1,
        summary: fullSetSummary,
      });

      const result = await service.list({ status: 'scheduled', limit: 50, offset: 0 });

      expect(result.items).toHaveLength(1); // narrowed by the status filter
      expect(result.summary).toEqual(fullSetSummary); // NOT narrowed
    });

    it('zero-fills every status key when the repo reports an empty table', async () => {
      const emptySummary = {
        total: 0,
        byStatus: { scheduled: 0, in_progress: 0, done: 0, cancelled: 0 },
      };
      repo.list.mockResolvedValue({ items: [], total: 0, summary: emptySummary });

      const result = await service.list({ limit: 50, offset: 0 });

      expect(result.summary).toEqual(emptySummary);
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

  describe('scheduleInstall (lead conversion)', () => {
    it('creates a scheduled install order linked to the new subscriber', async () => {
      repo.create.mockResolvedValue(installWo);
      const result = await service.scheduleInstall({
        customerId: CUSTOMER_ID,
        customerName: 'Budi Santoso',
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'install',
          customerId: CUSTOMER_ID,
          customerName: 'Budi Santoso',
          technician: null,
        }),
      );
      expect(result.type).toBe('install');
    });
  });

  describe('notifications — wo_scheduled', () => {
    it('enqueues wo_scheduled when an install is scheduled from onboarding', async () => {
      repo.create.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      const scheduledAt = new Date('2026-06-20T00:00:00.000Z');

      await service.scheduleInstallForCustomer({
        customerId: CUSTOMER_ID,
        customerName: 'Budi Santoso',
        technician: 'Teknisi Andi',
        scheduledAt,
      });

      expect(notifications.enqueue).toHaveBeenCalledWith(
        {
          event: 'wo_scheduled',
          to: '0812000001',
          vars: {
            nama: 'Budi Santoso',
            tipe: 'instalasi',
            kode: installWo.code,
            jadwal: installWo.scheduledAt.toISOString(),
          },
        },
        `wo_scheduled:${installWo.id}:${installWo.scheduledAt.toISOString()}`,
      );
    });

    it('enqueues wo_scheduled when an install is scheduled from a converted lead', async () => {
      repo.create.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);

      await service.scheduleInstall({ customerId: CUSTOMER_ID, customerName: 'Budi Santoso' });

      expect(notifications.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'wo_scheduled', to: '0812000001' }),
        `wo_scheduled:${installWo.id}:${installWo.scheduledAt.toISOString()}`,
      );
    });

    it('enqueues wo_scheduled when a repair is dispatched from a ticket with a linked customer', async () => {
      repo.create.mockResolvedValue(repairWo);
      customers.findById.mockResolvedValue(customerRow);

      await service.createFromTicket({
        ticketId: '00000000-0000-0000-0000-0000000000t1',
        customerId: CUSTOMER_ID,
        customerName: 'Budi Santoso',
      });

      expect(notifications.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'wo_scheduled',
          to: '0812000001',
          vars: expect.objectContaining({ tipe: 'perbaikan' }),
        }),
        `wo_scheduled:${repairWo.id}:${repairWo.scheduledAt.toISOString()}`,
      );
    });

    it('skips wo_scheduled for a repair dispatched with no linked customer', async () => {
      repo.create.mockResolvedValue({ ...repairWo, customerId: null });

      await service.createFromTicket({
        ticketId: '00000000-0000-0000-0000-0000000000t1',
        customerId: null,
        customerName: 'Belum ada subscriber',
      });

      expect(customers.findById).not.toHaveBeenCalled();
      expect(notifications.enqueue).not.toHaveBeenCalled();
    });

    it('skips wo_scheduled when the linked customer has no phone', async () => {
      repo.create.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue({ ...customerRow, phone: null });

      await service.scheduleInstall({ customerId: CUSTOMER_ID, customerName: 'Budi Santoso' });

      expect(notifications.enqueue).not.toHaveBeenCalled();
    });

    it('enqueues a fresh wo_scheduled (new jobId) on reschedule', async () => {
      const scheduled = { ...installWo, status: 'scheduled' as const };
      const newScheduledAt = new Date('2026-07-01T09:00:00.000Z');
      repo.findById.mockResolvedValue(scheduled);
      repo.patch.mockResolvedValue({ ...scheduled, scheduledAt: newScheduledAt });
      customers.findById.mockResolvedValue(customerRow);

      await service.reschedule(installWo.id, newScheduledAt);

      expect(notifications.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'wo_scheduled' }),
        `wo_scheduled:${installWo.id}:${newScheduledAt.toISOString()}`,
      );
    });

    // Best-effort (matches the resilience of the #109 emits): a queue outage
    // must never fail the WO write that already committed.
    it('does not fail scheduleInstall when the notification enqueue rejects', async () => {
      repo.create.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      notifications.enqueue.mockRejectedValue(new Error('queue down'));

      const result = await service.scheduleInstall({
        customerId: CUSTOMER_ID,
        customerName: 'Budi Santoso',
      });

      expect(result.type).toBe('install');
    });
  });

  describe('notifications — wo_done', () => {
    it('enqueues wo_done when a work order is completed', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      const done = {
        ...installWo,
        status: 'done' as const,
        completedAt: new Date('2026-06-16T12:30:00.000Z'),
        completedBy: AUTHOR,
      };
      repo.markDone.mockResolvedValue(done);

      await service.complete(installWo.id, AUTHOR);

      expect(notifications.enqueue).toHaveBeenCalledWith(
        {
          event: 'wo_done',
          to: '0812000001',
          vars: {
            nama: 'Budi Santoso',
            tipe: 'instalasi',
            kode: done.code,
            selesai: done.completedAt.toISOString(),
          },
        },
        `wo_done:${installWo.id}`,
      );
    });

    it('does not re-emit wo_done for an already-done order (idempotent)', async () => {
      repo.findById.mockResolvedValue({ ...installWo, status: 'done' });

      await service.complete(installWo.id, AUTHOR);

      expect(notifications.enqueue).not.toHaveBeenCalled();
    });

    it('skips wo_done when the linked customer has no phone', async () => {
      repo.findById.mockResolvedValue(repairWo);
      customers.findById.mockResolvedValue({ ...customerRow, phone: null });
      repo.markDone.mockResolvedValue({ ...repairWo, status: 'done' });

      await service.complete(repairWo.id, AUTHOR);

      expect(notifications.enqueue).not.toHaveBeenCalled();
    });

    // Best-effort (matches the resilience of the #109 emits): a queue outage
    // must never fail the completion that already committed.
    it('does not fail complete() when the notification enqueue rejects', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });
      notifications.enqueue.mockRejectedValue(new Error('queue down'));

      const result = await service.complete(installWo.id, AUTHOR);

      expect(result.status).toBe('done');
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
