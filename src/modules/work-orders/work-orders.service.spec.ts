import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkOrder } from '../../infrastructure/database/schema/work-orders.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { InventoryService } from '../inventory/inventory.service';
import { InvoicesService } from '../invoices/invoices.service';
import { ProfilesRepository } from '../router-resources/profiles.repository';
import { SecretsRepository } from '../router-resources/secrets.repository';
import { RoutersRepository } from '../routers/routers.repository';
import { WorkOrdersRepository } from './work-orders.repository';
import { WorkOrdersService } from './work-orders.service';

const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c1';

const installWo: WorkOrder = {
  id: '00000000-0000-0000-0000-00000000a001',
  code: 'WO-9001',
  type: 'install',
  customerId: CUSTOMER_ID,
  customerName: 'Budi Santoso',
  technician: 'Teknisi Budi',
  scheduledAt: new Date('2026-06-16T00:00:00.000Z'),
  status: 'scheduled',
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

const customerRow = {
  id: CUSTOMER_ID,
  customerNo: 'CUST-9001',
  fullName: 'Budi Santoso',
  planName: 'Home 20',
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

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      markDone: vi.fn(),
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
      ],
    }).compile();
    service = moduleRef.get(WorkOrdersService);
  });

  describe('complete', () => {
    it('runs the full install cascade: ONU + connection + secret + first invoice, then done', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });

      const result = await service.complete(installWo.id);

      // ONU consumed from warehouse and assigned to the subscriber.
      expect(inventory.move).toHaveBeenCalledWith('onu-1', {
        type: 'assign',
        note: 'Budi Santoso',
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
      expect(repo.markDone).toHaveBeenCalledWith(installWo.id);
      expect(result.status).toBe('done');
    });

    it('falls back to a synthetic ONU serial when warehouse stock is dry', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      inventory.findAvailableOnu.mockResolvedValue(null);
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });

      await service.complete(installWo.id);

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

      await service.complete(installWo.id);

      expect(secrets.create).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: 'prof-default', profileName: 'default' }),
      );
    });

    it('skips the PPPoE secret when no router exists (still activates + bills)', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue(customerRow);
      routers.findFirst.mockResolvedValue(null);
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });

      await service.complete(installWo.id);

      expect(secrets.create).not.toHaveBeenCalled();
      expect(routers.adjustSecretCount).not.toHaveBeenCalled();
      expect(customers.markInstalled).toHaveBeenCalledTimes(1);
      expect(invoices.generateFirstInvoice).toHaveBeenCalledWith(CUSTOMER_ID);
      expect(repo.markDone).toHaveBeenCalled();
    });

    it('is idempotent for an already-done order (no re-provisioning)', async () => {
      repo.findById.mockResolvedValue({ ...installWo, status: 'done' });
      const result = await service.complete(installWo.id);
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
      await service.complete(installWo.id);
      expect(inventory.findAvailableOnu).not.toHaveBeenCalled();
      expect(customers.markInstalled).not.toHaveBeenCalled();
      expect(secrets.create).not.toHaveBeenCalled();
      expect(invoices.generateFirstInvoice).not.toHaveBeenCalled();
      expect(repo.markDone).toHaveBeenCalled();
    });

    it('throws 404 for a missing order', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.complete('missing')).rejects.toBeInstanceOf(NotFoundException);
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
        customerId: CUSTOMER_ID,
        customerName: 'Budi Santoso',
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'repair',
          customerId: CUSTOMER_ID,
          technician: null,
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
});
