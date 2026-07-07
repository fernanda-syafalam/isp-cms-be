import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Reseller,
  ResellerPayout,
} from '../../infrastructure/database/schema/resellers.schema';
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

const payout: ResellerPayout = {
  id: '00000000-0000-0000-0000-0000000b0001',
  resellerId: reseller.id,
  amount: 400_000,
  status: 'requested',
  note: 'Cair mingguan',
  requestedBy: '00000000-0000-0000-0000-0000000a0aaa',
  decidedBy: null,
  ledgerEntryId: null,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
  decidedAt: null,
};

const actorId = '00000000-0000-0000-0000-0000000a0bbb';

describe('ResellersService', () => {
  let service: ResellersService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: {
    countByResellerId: ReturnType<typeof vi.fn>;
    countsByResellerId: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    repo = {
      list: vi.fn(),
      create: vi.fn(),
      findById: vi.fn(),
      update: vi.fn(),
      listLedger: vi.fn(),
      addLedgerEntry: vi.fn(),
      listPayouts: vi.fn(),
      createPayout: vi.fn(),
      findPayoutById: vi.fn(),
      approvePayout: vi.fn(),
      rejectPayout: vi.fn(),
      disbursePayout: vi.fn(),
    };
    customers = { countByResellerId: vi.fn(), countsByResellerId: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ResellersService,
        { provide: ResellersRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
      ],
    }).compile();
    service = moduleRef.get(ResellersService);
  });

  const summary = {
    total: 1,
    totalBalance: 1_000_000,
    byStatus: { active: 1, inactive: 0 },
  };

  it('list attaches derived customerCount by resellerId', async () => {
    repo.list.mockResolvedValue({ items: [reseller], total: 1, summary });
    customers.countsByResellerId.mockResolvedValue([{ resellerId: reseller.id, count: 7 }]);
    const result = await service.list({ limit: 50, offset: 0 });
    expect(result.items[0]?.customerCount).toBe(7);
    expect(result.items[0]?.commissionPct).toBe(0.05);
  });

  it('list passes the summary rollup through unchanged (FE contract parity)', async () => {
    repo.list.mockResolvedValue({ items: [reseller], total: 1, summary });
    customers.countsByResellerId.mockResolvedValue([]);
    const result = await service.list({ limit: 50, offset: 0 });
    expect(result.summary).toEqual(summary);
  });

  it('list forwards q, sort, and order to the repository unchanged', async () => {
    repo.list.mockResolvedValue({ items: [reseller], total: 1, summary });
    customers.countsByResellerId.mockResolvedValue([]);
    await service.list({ q: 'Jepara', sort: 'name', order: 'asc', limit: 10, offset: 0 });
    expect(repo.list).toHaveBeenCalledWith({
      q: 'Jepara',
      sort: 'name',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
  });

  it('findById uses the single resellerId count', async () => {
    repo.findById.mockResolvedValue(reseller);
    customers.countByResellerId.mockResolvedValue(3);
    const result = await service.findById(reseller.id);
    expect(customers.countByResellerId).toHaveBeenCalledWith(reseller.id);
    expect(result.customerCount).toBe(3);
  });

  it('update passes the patch through and re-counts', async () => {
    repo.update.mockResolvedValue({ ...reseller, status: 'inactive' });
    customers.countByResellerId.mockResolvedValue(0);
    const result = await service.update(reseller.id, { status: 'inactive' });
    expect(repo.update).toHaveBeenCalledWith(reseller.id, { status: 'inactive' });
    expect(result.status).toBe('inactive');
  });

  it('create inserts a new reseller with a zero customerCount, no count query', async () => {
    repo.create.mockResolvedValue({ ...reseller, balance: 0 });
    const result = await service.create({
      name: 'Loket Andi',
      area: 'Jepara',
      commissionPct: 0.05,
    });
    expect(repo.create).toHaveBeenCalledWith({
      name: 'Loket Andi',
      area: 'Jepara',
      commissionPct: 0.05,
      status: 'active',
    });
    expect(result.customerCount).toBe(0);
    expect(customers.countByResellerId).not.toHaveBeenCalled();
  });

  it('addLedgerEntry rejects a bare withdrawal with 422 — must go through the payout flow', async () => {
    await expect(
      service.addLedgerEntry(reseller.id, { type: 'withdrawal', amount: 100_000 }),
    ).rejects.toThrow();
    expect(repo.addLedgerEntry).not.toHaveBeenCalled();
  });

  it('addLedgerEntry defaults note and returns the updated reseller', async () => {
    repo.addLedgerEntry.mockResolvedValue({ ...reseller, balance: 1_500_000 });
    customers.countByResellerId.mockResolvedValue(7);
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

  describe('payout lifecycle (P3.D.4)', () => {
    it('requestPayout forwards amount/note/actor and returns the mapped response', async () => {
      repo.createPayout.mockResolvedValue(payout);
      const result = await service.requestPayout(
        reseller.id,
        { amount: 400_000, note: 'Cair mingguan' },
        actorId,
      );
      expect(repo.createPayout).toHaveBeenCalledWith(reseller.id, {
        amount: 400_000,
        note: 'Cair mingguan',
        requestedBy: actorId,
      });
      expect(result.status).toBe('requested');
      expect(result.ledgerEntryId).toBeNull();
    });

    it('the full happy path: request -> approve -> disburse', async () => {
      repo.findById.mockResolvedValue(reseller);
      repo.createPayout.mockResolvedValue(payout);
      const requested = await service.requestPayout(reseller.id, { amount: 400_000 }, actorId);
      expect(requested.status).toBe('requested');

      repo.findPayoutById.mockResolvedValue(payout);
      const approvedRow: ResellerPayout = {
        ...payout,
        status: 'approved',
        decidedBy: actorId,
        decidedAt: new Date('2026-06-16T00:00:00.000Z'),
      };
      repo.approvePayout.mockResolvedValue(approvedRow);
      const approved = await service.approvePayout(reseller.id, payout.id, actorId);
      expect(repo.approvePayout).toHaveBeenCalledWith(payout.id, actorId);
      expect(approved.status).toBe('approved');

      repo.findPayoutById.mockResolvedValue(approvedRow);
      const paidRow: ResellerPayout = {
        ...approvedRow,
        status: 'paid',
        ledgerEntryId: '00000000-0000-0000-0000-0000000c0001',
      };
      repo.disbursePayout.mockResolvedValue(paidRow);
      const paid = await service.disbursePayout(reseller.id, payout.id, actorId);
      expect(repo.disbursePayout).toHaveBeenCalledWith(payout.id);
      expect(paid.status).toBe('paid');
      expect(paid.ledgerEntryId).toBe('00000000-0000-0000-0000-0000000c0001');
    });

    it('reject: requested -> rejected', async () => {
      repo.findById.mockResolvedValue(reseller);
      repo.findPayoutById.mockResolvedValue(payout);
      const rejectedRow: ResellerPayout = {
        ...payout,
        status: 'rejected',
        decidedBy: actorId,
        decidedAt: new Date('2026-06-16T00:00:00.000Z'),
      };
      repo.rejectPayout.mockResolvedValue(rejectedRow);
      const result = await service.rejectPayout(reseller.id, payout.id, actorId);
      expect(repo.rejectPayout).toHaveBeenCalledWith(payout.id, actorId);
      expect(result.status).toBe('rejected');
    });

    it('approve/reject/disburse 404 when the payout id does not belong to this reseller', async () => {
      repo.findById.mockResolvedValue(reseller);
      repo.findPayoutById.mockResolvedValue({
        ...payout,
        resellerId: '00000000-0000-0000-0000-00000000ffff',
      });

      await expect(service.approvePayout(reseller.id, payout.id, actorId)).rejects.toThrow();
      await expect(service.rejectPayout(reseller.id, payout.id, actorId)).rejects.toThrow();
      await expect(service.disbursePayout(reseller.id, payout.id, actorId)).rejects.toThrow();
      expect(repo.approvePayout).not.toHaveBeenCalled();
      expect(repo.rejectPayout).not.toHaveBeenCalled();
      expect(repo.disbursePayout).not.toHaveBeenCalled();
    });

    it('approve/reject/disburse 404 when the payout does not exist at all', async () => {
      repo.findById.mockResolvedValue(reseller);
      repo.findPayoutById.mockResolvedValue(null);

      await expect(service.approvePayout(reseller.id, 'missing', actorId)).rejects.toThrow();
      await expect(service.rejectPayout(reseller.id, 'missing', actorId)).rejects.toThrow();
      await expect(service.disbursePayout(reseller.id, 'missing', actorId)).rejects.toThrow();
    });

    it('an illegal transition (repository 422) propagates unchanged — e.g. approving a paid payout', async () => {
      repo.findById.mockResolvedValue(reseller);
      repo.findPayoutById.mockResolvedValue({ ...payout, status: 'paid' });
      repo.approvePayout.mockRejectedValue(new Error('422'));

      await expect(service.approvePayout(reseller.id, payout.id, actorId)).rejects.toThrow();
    });

    it('disburse propagates the repository 422 on insufficient balance', async () => {
      repo.findById.mockResolvedValue(reseller);
      repo.findPayoutById.mockResolvedValue({ ...payout, status: 'approved' });
      repo.disbursePayout.mockRejectedValue(new Error('Saldo tidak mencukupi'));

      await expect(service.disbursePayout(reseller.id, payout.id, actorId)).rejects.toThrow(
        'Saldo tidak mencukupi',
      );
    });

    it('listPayouts scopes ownership like listLedger and maps entries', async () => {
      repo.findById.mockResolvedValue(reseller);
      repo.listPayouts.mockResolvedValue({ items: [payout], total: 1 });
      const filter = { status: 'requested' as const, limit: 50, offset: 0 };
      const result = await service.listPayouts(reseller.id, filter);
      expect(repo.listPayouts).toHaveBeenCalledWith(reseller.id, filter);
      expect(result.items[0]?.id).toBe(payout.id);
      expect(result.total).toBe(1);
    });

    it('a mitra reading another reseller payouts 404s (ownership scoping)', async () => {
      const mitraUser = {
        id: 'u1',
        email: 'mitra@x.test',
        fullName: 'Mitra',
        role: 'mitra' as const,
        resellerId: '00000000-0000-0000-0000-00000000ffff',
      };
      await expect(
        service.listPayouts(reseller.id, { limit: 50, offset: 0 }, mitraUser),
      ).rejects.toThrow();
      expect(repo.listPayouts).not.toHaveBeenCalled();
    });
  });
});
