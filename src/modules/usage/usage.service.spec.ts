import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomersRepository } from '../customers/customers.repository';
import { UsageService } from './usage.service';

// Shared fixture: three subscribers covering all quota tiers + FUP states.
const THREE_SUBSCRIBERS = [
  // index 0 — unlimited (>=100 Mbps): usedGb = 300 + 0*40 = 300, fupThrottled = false
  {
    id: '00000000-0000-0000-0000-0000000000c1',
    fullName: 'Andi',
    planName: 'Pro 100',
    planSpeedMbps: 100,
  },
  // index 1 — 1000 GB quota (50 Mbps): usedGb = round(1000*(0.4+1*0.12)) = round(520) = 520
  {
    id: '00000000-0000-0000-0000-0000000000c2',
    fullName: 'Budi',
    planName: 'Home 50',
    planSpeedMbps: 50,
  },
  // index 2 — 500 GB quota (20 Mbps): usedGb = round(500*(0.4+2*0.12)) = round(320) = 320
  {
    id: '00000000-0000-0000-0000-0000000000c3',
    fullName: 'Citra',
    planName: 'Home 20',
    planSpeedMbps: 20,
  },
];

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

  // --- existing behaviour (unchanged) ---

  it('derives unlimited quota for >=100 Mbps plans', async () => {
    customers.findForUsage.mockResolvedValue([
      {
        id: '00000000-0000-0000-0000-0000000000c1',
        fullName: 'Budi',
        planName: 'Pro 100',
        planSpeedMbps: 100,
      },
    ]);
    const result = await service.list({ limit: 100, offset: 0 });
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
    const result = await service.list({ limit: 100, offset: 0 });
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
    const result = await service.list({ limit: 100, offset: 0 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.summary).toEqual({ totalUsedGb: 0, throttled: 0, avgUsedGb: 0 });
  });

  // --- search (q) ---

  describe('search (q)', () => {
    it('filters by customerName (case-insensitive substring)', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const result = await service.list({ q: 'andi', limit: 100, offset: 0 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.customerName).toBe('Andi');
      expect(result.total).toBe(1);
    });

    it('filters by planName (case-insensitive substring)', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const result = await service.list({ q: 'Home', limit: 100, offset: 0 });
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.items.every((r) => r.planName.toLowerCase().includes('home'))).toBe(true);
    });

    it('returns empty items when q matches nothing', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const result = await service.list({ q: 'NONEXISTENT', limit: 100, offset: 0 });
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  // --- sort ---

  describe('sort', () => {
    it('sorts by usedGb asc', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const result = await service.list({ sort: 'usedGb', order: 'asc', limit: 100, offset: 0 });
      const useds = result.items.map((r) => r.usedGb);
      expect(useds).toEqual([...useds].sort((a, b) => a - b));
    });

    it('sorts by usedGb desc', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const result = await service.list({ sort: 'usedGb', order: 'desc', limit: 100, offset: 0 });
      const useds = result.items.map((r) => r.usedGb);
      expect(useds).toEqual([...useds].sort((a, b) => b - a));
    });

    it('falls back to customerName asc for unknown sort key', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const result = await service.list({ sort: 'unknownKey', limit: 100, offset: 0 });
      const names = result.items.map((r) => r.customerName);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });

    it('default order is customerName asc when no sort/order given', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const result = await service.list({ limit: 100, offset: 0 });
      const names = result.items.map((r) => r.customerName);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });
  });

  // --- pagination ---

  describe('pagination', () => {
    it('returns the first page with limit 1, offset 0', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const result = await service.list({ limit: 1, offset: 0 });
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(3);
    });

    it('returns the second item with limit 1, offset 1', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const p1 = await service.list({ limit: 1, offset: 0 });
      const p2 = await service.list({ limit: 1, offset: 1 });
      expect(p2.items).toHaveLength(1);
      expect(p2.items[0]?.customerId).not.toBe(p1.items[0]?.customerId);
    });

    it('total reflects filtered count before paging (q + limit/offset)', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      // q matches 2 rows, limit=1 => items has 1 row but total=2
      const result = await service.list({ q: 'Home', limit: 1, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(1);
    });
  });

  // --- summary invariant ---

  describe('summary — full-set invariant', () => {
    it('summary fields are integers derived from the full computed set', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const result = await service.list({ limit: 100, offset: 0 });
      const { summary } = result;
      expect(Number.isInteger(summary.totalUsedGb)).toBe(true);
      expect(Number.isInteger(summary.throttled)).toBe(true);
      expect(Number.isInteger(summary.avgUsedGb)).toBe(true);
    });

    it('summary is unchanged when q narrows the item list', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const full = await service.list({ limit: 100, offset: 0 });
      const narrow = await service.list({ q: 'Andi', limit: 100, offset: 0 });
      // items/total differ, summary stays the same
      expect(narrow.total).toBe(1);
      expect(narrow.summary).toEqual(full.summary);
    });

    it('summary is unchanged when paging changes the visible items', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const full = await service.list({ limit: 100, offset: 0 });
      const page2 = await service.list({ limit: 1, offset: 2 });
      expect(page2.items).toHaveLength(1);
      expect(page2.summary).toEqual(full.summary);
    });

    it('avgUsedGb is Math.round(totalUsedGb / rowCount)', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const result = await service.list({ limit: 100, offset: 0 });
      const { totalUsedGb, avgUsedGb } = result.summary;
      const expectedAvg = Math.round(totalUsedGb / THREE_SUBSCRIBERS.length);
      expect(avgUsedGb).toBe(expectedAvg);
    });

    it('throttled counts only rows where fupThrottled is true', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const result = await service.list({ limit: 100, offset: 0 });
      const expectedThrottled = result.items.filter((r) => r.fupThrottled).length;
      // summary.throttled is full-set; since no q filter, items IS the full set here
      expect(result.summary.throttled).toBe(expectedThrottled);
    });
  });

  // --- forCustomer (portal self-care, P3.C.4) ---

  describe('forCustomer', () => {
    it('returns exactly the same row a staff list() call would compute for that customer', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      const list = await service.list({ limit: 100, offset: 0 });
      const staffRow = list.items.find(
        (r) => r.customerId === '00000000-0000-0000-0000-0000000000c2',
      );

      const portalRow = await service.forCustomer('00000000-0000-0000-0000-0000000000c2');

      expect(portalRow).toEqual(staffRow);
    });

    it('404s when the customer id is not in the provisioned set', async () => {
      customers.findForUsage.mockResolvedValue(THREE_SUBSCRIBERS);
      await expect(
        service.forCustomer('00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when there are no provisioned subscribers at all', async () => {
      customers.findForUsage.mockResolvedValue([]);
      await expect(
        service.forCustomer('00000000-0000-0000-0000-0000000000c1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
