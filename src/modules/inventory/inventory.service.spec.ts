import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryItem } from '../../infrastructure/database/schema/inventory.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';

const item: InventoryItem = {
  id: '00000000-0000-0000-0000-00000000b001',
  kind: 'onu',
  serial: 'ZTEG00000001',
  status: 'warehouse',
  assignedTo: null,
  assignedCustomerId: null,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('InventoryService', () => {
  let service: InventoryService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: { findIdByFullName: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      listMovements: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      addMovement: vi.fn(),
    };
    customers = { findIdByFullName: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: InventoryRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
      ],
    }).compile();
    service = moduleRef.get(InventoryService);
  });

  describe('listMovements', () => {
    it('forwards filter (q/sort/order) straight to repo and maps rows', async () => {
      const movement = {
        id: '00000000-0000-0000-0000-00000000c001',
        itemId: item.id,
        serial: item.serial,
        kind: item.kind as 'onu',
        type: 'in' as const,
        note: 'Stok masuk',
        at: new Date('2026-06-15T00:00:00.000Z'),
      };
      repo.listMovements.mockResolvedValue({ items: [movement], total: 1 });

      const filter = { q: 'ZTEG', sort: 'serial', order: 'asc' as const, limit: 50, offset: 0 };
      const result = await service.listMovements(filter);

      expect(repo.listMovements).toHaveBeenCalledWith(filter);
      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        id: movement.id,
        serial: movement.serial,
        at: movement.at.toISOString(),
      });
    });

    it('returns empty list and total 0 when repo returns nothing', async () => {
      repo.listMovements.mockResolvedValue({ items: [], total: 0 });

      const result = await service.listMovements({ q: 'nomatch', limit: 50, offset: 0 });
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  it('stockIn creates an item and logs an `in` movement', async () => {
    repo.create.mockResolvedValue(item);
    await service.stockIn({ kind: 'onu', serial: 'ZTEG00000001' });
    expect(repo.create).toHaveBeenCalledWith({ kind: 'onu', serial: 'ZTEG00000001' });
    expect(repo.addMovement).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'in', note: 'Stok masuk', itemId: item.id }),
    );
  });

  describe('move', () => {
    it('assign installs the item, resolves the customer id, and logs the name', async () => {
      repo.findById.mockResolvedValue(item);
      customers.findIdByFullName.mockResolvedValue('cust-1');
      repo.update.mockResolvedValue({
        ...item,
        status: 'installed',
        assignedTo: 'Budi',
        assignedCustomerId: 'cust-1',
      });

      const result = await service.move(item.id, { type: 'assign', note: 'Budi' });

      expect(customers.findIdByFullName).toHaveBeenCalledWith('Budi');
      expect(repo.update).toHaveBeenCalledWith(item.id, {
        status: 'installed',
        assignedTo: 'Budi',
        assignedCustomerId: 'cust-1',
      });
      // No work order supplied -> the movement records a null link.
      expect(repo.addMovement).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'assign', note: 'Budi', workOrderId: null }),
      );
      expect(result.assignedCustomerId).toBe('cust-1');
    });

    // ADR-0003/0009: an install-driven assign records its work order so stock
    // consumption reconciles with the order.
    it('records the work order id on the movement when supplied', async () => {
      repo.findById.mockResolvedValue(item);
      customers.findIdByFullName.mockResolvedValue('cust-1');
      repo.update.mockResolvedValue({ ...item, status: 'installed', assignedTo: 'Budi' });

      await service.move(item.id, { type: 'assign', note: 'Budi', workOrderId: 'wo-1' });

      expect(repo.addMovement).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'assign', workOrderId: 'wo-1' }),
      );
    });

    it('return sends the item back to the warehouse and clears the assignment', async () => {
      repo.findById.mockResolvedValue({ ...item, status: 'installed', assignedTo: 'Budi' });
      repo.update.mockResolvedValue(item);
      await service.move(item.id, { type: 'return' });
      expect(repo.update).toHaveBeenCalledWith(item.id, {
        status: 'warehouse',
        assignedTo: null,
        assignedCustomerId: null,
      });
      expect(repo.addMovement).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'return', note: 'Dikembalikan ke gudang' }),
      );
    });

    it('broken retires the item with the given note', async () => {
      repo.findById.mockResolvedValue(item);
      repo.update.mockResolvedValue({ ...item, status: 'broken' });
      await service.move(item.id, { type: 'broken', note: 'Port mati' });
      expect(repo.update).toHaveBeenCalledWith(item.id, { status: 'broken' });
      expect(repo.addMovement).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'broken', note: 'Port mati' }),
      );
    });

    it('throws 404 for a missing item', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.move('missing', { type: 'broken' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('resolves the customer id when assignedTo is set and logs no movement', async () => {
      customers.findIdByFullName.mockResolvedValue('cust-9');
      repo.update.mockResolvedValue({ ...item, assignedTo: 'Sari', assignedCustomerId: 'cust-9' });
      await service.update(item.id, { assignedTo: 'Sari' });
      expect(repo.update).toHaveBeenCalledWith(item.id, {
        assignedTo: 'Sari',
        assignedCustomerId: 'cust-9',
      });
      expect(repo.addMovement).not.toHaveBeenCalled();
    });

    it('clears the customer id when assignedTo is null', async () => {
      repo.update.mockResolvedValue(item);
      await service.update(item.id, { assignedTo: null });
      expect(repo.update).toHaveBeenCalledWith(item.id, {
        assignedTo: null,
        assignedCustomerId: null,
      });
      expect(customers.findIdByFullName).not.toHaveBeenCalled();
    });
  });
});
