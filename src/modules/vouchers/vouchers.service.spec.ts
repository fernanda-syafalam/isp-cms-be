import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Voucher } from '../../infrastructure/database/schema/vouchers.schema';
import { VouchersRepository } from './vouchers.repository';
import { VouchersService } from './vouchers.service';

const makeVoucher = (overrides: Partial<Voucher> = {}): Voucher => ({
  id: '00000000-0000-0000-0000-00000000c001',
  code: 'ASH-ABCD-2345',
  batchId: 'BATCH-DEADBEEF',
  profile: 'Hotspot 1 Hari',
  priceIdr: 5_000,
  durationDays: 1,
  status: 'unused',
  usedAt: null,
  usedBy: null,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
  ...overrides,
});

const voucher = makeVoucher();

// Default full-set summary returned by the mock repo
const defaultSummary = { total: 10, unused: 7, used: 2, revenue: 10_000 };

describe('VouchersService', () => {
  let service: VouchersService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = { list: vi.fn(), findById: vi.fn(), createBatch: vi.fn(), redeem: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [VouchersService, { provide: VouchersRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(VouchersService);
  });

  describe('generateBatch', () => {
    it('mints count vouchers sharing one batch id with well-formed unique codes', async () => {
      repo.createBatch.mockResolvedValue(3);
      const result = await service.generateBatch({
        count: 3,
        profile: 'Hotspot 1 Hari',
        priceIdr: 5_000,
        durationDays: 1,
      });

      expect(result.created).toBe(3);
      expect(result.batchId).toMatch(/^BATCH-[0-9A-F]{8}$/);

      const rows = repo.createBatch.mock.calls[0]?.[0] as Array<{ code: string; batchId: string }>;
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.batchId)).size).toBe(1); // one shared batch
      expect(new Set(rows.map((r) => r.code)).size).toBe(3); // distinct codes
      for (const r of rows) {
        expect(r.code).toMatch(/^ASH-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      }
    });
  });

  it('redeems a voucher', async () => {
    repo.redeem.mockResolvedValue({
      ...voucher,
      status: 'used',
      usedAt: new Date('2026-06-15T10:00:00.000Z'),
      usedBy: 'Admin (manual)',
    });
    const result = await service.redeem(voucher.id);
    expect(repo.redeem).toHaveBeenCalledWith(voucher.id);
    expect(result.status).toBe('used');
    expect(result.usedAt).toBe('2026-06-15T10:00:00.000Z');
    expect(result.usedBy).toBe('Admin (manual)');
  });

  // ---------------------------------------------------------------------------
  // list — preserved + extended tests
  // ---------------------------------------------------------------------------

  describe('list', () => {
    it('maps a voucher list and includes summary (unfiltered)', async () => {
      repo.list.mockResolvedValue({ items: [voucher], total: 1, summary: defaultSummary });
      const result = await service.list({ limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.code).toBe('ASH-ABCD-2345');
      expect(result.items[0]?.usedAt).toBeNull();
      expect(result.summary).toEqual(defaultSummary);
    });

    it('status filter shrinks items and total but summary is unchanged (the invariant)', async () => {
      // Only 2 unused vouchers in this filtered page, but full-set summary stays at 10 total.
      const unusedVoucher = makeVoucher({ status: 'unused' });
      repo.list.mockResolvedValue({
        items: [unusedVoucher, unusedVoucher],
        total: 2,
        summary: defaultSummary,
      });
      const result = await service.list({ status: 'unused', limit: 50, offset: 0 });
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      // Summary must reflect the full set, not just the filtered slice.
      expect(result.summary.total).toBe(10);
      expect(result.summary.unused).toBe(7);
      expect(result.summary.used).toBe(2);
      expect(result.summary.revenue).toBe(10_000);
    });

    it('q search passes the filter to the repo and returns matching items', async () => {
      const matched = makeVoucher({ code: 'ASH-QRST-5678', profile: 'Hotspot 3 Hari' });
      repo.list.mockResolvedValue({ items: [matched], total: 1, summary: defaultSummary });
      const result = await service.list({ q: 'QRST', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'QRST' }));
      expect(result.items[0]?.code).toBe('ASH-QRST-5678');
      expect(result.total).toBe(1);
      // Summary unaffected by q.
      expect(result.summary).toEqual(defaultSummary);
    });

    it('forwards sort and order to the repo', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0, summary: defaultSummary });
      await service.list({ sort: 'priceIdr', order: 'asc', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'priceIdr', order: 'asc' }),
      );
    });

    it('forwards desc sort to the repo', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0, summary: defaultSummary });
      await service.list({ sort: 'code', order: 'desc', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'code', order: 'desc' }),
      );
    });

    it('unknown sort key is forwarded to the repo (repo falls back to default via buildOrderBy)', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0, summary: defaultSummary });
      await service.list({ sort: 'thisKeyDoesNotExist', order: 'asc', limit: 50, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'thisKeyDoesNotExist' }),
      );
    });

    it('limit/offset paging keeps total and summary unaffected', async () => {
      const page2Item = makeVoucher({ id: '00000000-0000-0000-0000-00000000c002' });
      repo.list.mockResolvedValue({
        items: [page2Item],
        total: 50, // 50 total matches before paging
        summary: defaultSummary,
      });
      const result = await service.list({ limit: 10, offset: 10 });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, offset: 10 }));
      // total is full filtered count, not just page size
      expect(result.total).toBe(50);
      // summary is always full-set
      expect(result.summary).toEqual(defaultSummary);
    });

    it('revenue sums only used vouchers priceIdr in summary', async () => {
      // Three vouchers: 2 used at 5_000 + 10_000, 1 unused at 3_000
      const summaryWithRevenue = { total: 3, unused: 1, used: 2, revenue: 15_000 };
      repo.list.mockResolvedValue({ items: [], total: 0, summary: summaryWithRevenue });
      const result = await service.list({ limit: 50, offset: 0 });
      expect(result.summary.revenue).toBe(15_000);
      expect(result.summary.used).toBe(2);
      expect(result.summary.unused).toBe(1);
    });
  });
});
