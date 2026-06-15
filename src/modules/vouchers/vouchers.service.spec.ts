import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Voucher } from '../../infrastructure/database/schema/vouchers.schema';
import { VouchersRepository } from './vouchers.repository';
import { VouchersService } from './vouchers.service';

const voucher: Voucher = {
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
};

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

  it('maps a voucher list', async () => {
    repo.list.mockResolvedValue({ items: [voucher], total: 1 });
    const result = await service.list({ limit: 100, offset: 0 });
    expect(result.total).toBe(1);
    expect(result.items[0]?.code).toBe('ASH-ABCD-2345');
    expect(result.items[0]?.usedAt).toBeNull();
  });
});
