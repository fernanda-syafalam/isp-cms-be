import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomersRepository } from '../customers/customers.repository';
import { UsageService } from './usage.service';

describe('UsageService', () => {
  let service: UsageService;
  let customers: { findForUsage: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    customers = { findForUsage: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [UsageService, { provide: CustomersRepository, useValue: customers }],
    }).compile();
    service = moduleRef.get(UsageService);
  });

  it('derives unlimited quota for >=100 Mbps plans', async () => {
    customers.findForUsage.mockResolvedValue([
      {
        id: '00000000-0000-0000-0000-0000000000c1',
        fullName: 'Budi',
        planName: 'Pro 100',
        planSpeedMbps: 100,
      },
    ]);
    const result = await service.list();
    expect(result.total).toBe(1);
    const r = result.items[0];
    expect(r?.quotaGb).toBe(0);
    expect(r?.fupThrottled).toBe(false);
    expect(r?.trend).toHaveLength(7);
  });

  it('derives quota tiers and FUP for capped plans', async () => {
    customers.findForUsage.mockResolvedValue([
      {
        id: '00000000-0000-0000-0000-0000000000c2',
        fullName: 'Ani',
        planName: 'Home 50',
        planSpeedMbps: 50,
      },
      {
        id: '00000000-0000-0000-0000-0000000000c3',
        fullName: 'Citra',
        planName: 'Home 20',
        planSpeedMbps: 20,
      },
    ]);
    const result = await service.list();
    const [a, c] = result.items;
    expect(a?.quotaGb).toBe(1000);
    expect(c?.quotaGb).toBe(500);
    // usedGb never exceeds a sane fraction of quota; fupThrottled is a pure
    // function of quota vs used
    for (const item of result.items) {
      expect(item.fupThrottled).toBe(item.quotaGb > 0 && item.usedGb >= item.quotaGb);
      expect(item.usedGb).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns an empty list when there are no provisioned subscribers', async () => {
    customers.findForUsage.mockResolvedValue([]);
    await expect(service.list()).resolves.toEqual({ items: [], total: 0 });
  });
});
