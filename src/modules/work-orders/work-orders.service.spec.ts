import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkOrder } from '../../infrastructure/database/schema/work-orders.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { InvoicesService } from '../invoices/invoices.service';
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

describe('WorkOrdersService', () => {
  let service: WorkOrdersService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: Record<string, ReturnType<typeof vi.fn>>;
  let invoices: { generateFirstInvoice: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      markDone: vi.fn(),
    };
    customers = { findById: vi.fn(), markInstalled: vi.fn() };
    invoices = { generateFirstInvoice: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WorkOrdersService,
        { provide: WorkOrdersRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
        { provide: InvoicesService, useValue: invoices },
      ],
    }).compile();
    service = moduleRef.get(WorkOrdersService);
  });

  describe('complete', () => {
    it('runs the install cascade: provision connection + first invoice, then mark done', async () => {
      repo.findById.mockResolvedValue(installWo);
      customers.findById.mockResolvedValue({
        id: CUSTOMER_ID,
        customerNo: 'CUST-9001',
        planName: 'Home 20',
      });
      repo.markDone.mockResolvedValue({ ...installWo, status: 'done' });

      const result = await service.complete(installWo.id);

      expect(customers.markInstalled).toHaveBeenCalledTimes(1);
      const [, connection] = customers.markInstalled.mock.calls[0] ?? [];
      expect(connection).toMatchObject({
        type: 'gpon',
        pppoeUsername: 'cust9001',
        profile: 'Home 20',
      });
      expect(invoices.generateFirstInvoice).toHaveBeenCalledWith(CUSTOMER_ID);
      expect(repo.markDone).toHaveBeenCalledWith(installWo.id);
      expect(result.status).toBe('done');
    });

    it('is idempotent for an already-done order (no re-provisioning)', async () => {
      repo.findById.mockResolvedValue({ ...installWo, status: 'done' });
      const result = await service.complete(installWo.id);
      expect(customers.markInstalled).not.toHaveBeenCalled();
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
      expect(customers.markInstalled).not.toHaveBeenCalled();
      expect(invoices.generateFirstInvoice).not.toHaveBeenCalled();
      expect(repo.markDone).toHaveBeenCalled();
    });

    it('throws 404 for a missing order', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.complete('missing')).rejects.toBeInstanceOf(NotFoundException);
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
});
