import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reseller } from '../../infrastructure/database/schema/resellers.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { ResellersRepository } from './resellers.repository';
import { ResellersService } from './resellers.service';

const reseller: Reseller = {
  id: '00000000-0000-0000-0000-00000000f001',
  name: 'Loket Andi',
  area: 'Jepara',
  balance: 1_000_000,
  commissionPct: 0.05,
  status: 'active',
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('ResellersService', () => {
  let service: ResellersService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: {
    countByResellerName: ReturnType<typeof vi.fn>;
    countsByResellerName: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      update: vi.fn(),
      listLedger: vi.fn(),
      addLedgerEntry: vi.fn(),
    };
    customers = { countByResellerName: vi.fn(), countsByResellerName: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ResellersService,
        { provide: ResellersRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
      ],
    }).compile();
    service = moduleRef.get(ResellersService);
  });

  it('list attaches derived customerCount by name', async () => {
    repo.list.mockResolvedValue({ items: [reseller], total: 1 });
    customers.countsByResellerName.mockResolvedValue([{ resellerName: 'Loket Andi', count: 7 }]);
    const result = await service.list({ limit: 50, offset: 0 });
    expect(result.items[0]?.customerCount).toBe(7);
    expect(result.items[0]?.commissionPct).toBe(0.05);
  });

  it('list forwards q, sort, and order to the repository unchanged', async () => {
    repo.list.mockResolvedValue({ items: [reseller], total: 1 });
    customers.countsByResellerName.mockResolvedValue([]);
    await service.list({ q: 'Jepara', sort: 'name', order: 'asc', limit: 10, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({
      q: 'Jepara',
      sort: 'name',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
  });

  it('findById uses the single-name count', async () => {
    repo.findById.mockResolvedValue(reseller);
    customers.countByResellerName.mockResolvedValue(3);
    const result = await service.findById(reseller.id);
    expect(customers.countByResellerName).toHaveBeenCalledWith('Loket Andi');
    expect(result.customerCount).toBe(3);
  });

  it('update passes the patch through and re-counts', async () => {
    repo.update.mockResolvedValue({ ...reseller, status: 'inactive' });
    customers.countByResellerName.mockResolvedValue(0);
    const result = await service.update(reseller.id, { status: 'inactive' });
    expect(repo.update).toHaveBeenCalledWith(reseller.id, { status: 'inactive' });
    expect(result.status).toBe('inactive');
  });

  it('addLedgerEntry defaults note and returns the updated reseller', async () => {
    repo.addLedgerEntry.mockResolvedValue({ ...reseller, balance: 1_500_000 });
    customers.countByResellerName.mockResolvedValue(7);
    const result = await service.addLedgerEntry(reseller.id, { type: 'topup', amount: 500_000 });
    expect(repo.addLedgerEntry).toHaveBeenCalledWith(reseller.id, {
      type: 'topup',
      amount: 500_000,
      note: '',
    });
    expect(result.balance).toBe(1_500_000);
  });

  it('listLedger maps entries and forwards filter to repo', async () => {
    repo.findById.mockResolvedValue(reseller);
    repo.listLedger.mockResolvedValue({
      items: [
        {
          id: '00000000-0000-0000-0000-0000000a0001',
          resellerId: reseller.id,
          type: 'commission',
          amount: 175_000,
          note: 'Komisi',
          balanceAfter: 1_175_000,
          at: new Date('2026-06-15T10:00:00.000Z'),
        },
      ],
      total: 1,
    });
    const filter = { q: 'Komisi', sort: 'at', order: 'desc' as const, limit: 10, offset: 0 };
    const result = await service.listLedger(reseller.id, filter);
    expect(repo.listLedger).toHaveBeenCalledWith(reseller.id, filter);
    expect(result.items[0]?.at).toBe('2026-06-15T10:00:00.000Z');
    expect(result.items[0]?.amount).toBe(175_000);
    expect(result.total).toBe(1);
  });

  it('listLedger with default filter (no q) forwards full filter to repo', async () => {
    repo.findById.mockResolvedValue(reseller);
    repo.listLedger.mockResolvedValue({ items: [], total: 0 });
    const filter = { limit: 50, offset: 0 };
    await service.listLedger(reseller.id, filter);
    expect(repo.listLedger).toHaveBeenCalledWith(reseller.id, filter);
  });
});
