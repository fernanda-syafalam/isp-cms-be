import { ConflictException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OdpRecordRow } from '../../infrastructure/database/schema/odp.schema';
import type { OdpSummary } from './dto/odp-response.dto';
import { OdpRepository } from './odp.repository';
import { OdpService } from './odp.service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ts = new Date('2026-06-17T00:00:00.000Z');

const rowHealthy: OdpRecordRow = {
  id: '0d90d900-1111-4111-8111-000000000000',
  name: 'ODP-JEP-01',
  area: 'Jepara',
  splitter: '1:16',
  totalPorts: 16,
  usedPorts: 2,
  avgRxPowerDbm: -18,
  status: 'healthy',
  createdAt: ts,
  updatedAt: ts,
};

const rowWarning: OdpRecordRow = {
  id: '0d90d900-1111-4111-8111-000000000001',
  name: 'ODP-TAH-02',
  area: 'Tahunan',
  splitter: '1:8',
  totalPorts: 8,
  usedPorts: 8, // full (no free port)
  avgRxPowerDbm: -26,
  status: 'warning',
  createdAt: ts,
  updatedAt: ts,
};

const rowCritical: OdpRecordRow = {
  id: '0d90d900-1111-4111-8111-000000000002',
  name: 'ODP-PEC-03',
  area: 'Pecangaan',
  splitter: '1:8',
  totalPorts: 8,
  usedPorts: 4,
  avgRxPowerDbm: -28,
  status: 'critical',
  createdAt: ts,
  updatedAt: ts,
};

/**
 * Full-set summary for the three fixture rows:
 *   totalOdp  = 3
 *   usedPorts = 2 + 8 + 4 = 14,  totalPorts = 16 + 8 + 8 = 32
 *   utilization = round(14/32 * 100) = round(43.75) = 44
 *   available = 2 (rowHealthy: 16-2=14 free, rowCritical: 8-4=4 free)
 *   full    = 1 (rowWarning: 8-8=0)
 *   optical = 2 (rowWarning + rowCritical, both !== 'healthy')
 */
const FULL_SUMMARY: OdpSummary = {
  totalOdp: 3,
  utilization: 44,
  available: 2,
  full: 1,
  optical: 2,
};

// Default paging used by most test calls.
const PAGE = { limit: 100, offset: 0 } as const;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('OdpService', () => {
  let service: OdpService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = {
      ensureSeeded: vi.fn(),
      list: vi.fn(),
      findById: vi.fn(),
      assignPort: vi.fn(),
      releasePort: vi.fn(),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [OdpService, { provide: OdpRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(OdpService);
  });

  // --- legacy behaviour (unchanged) -----------------------------------------

  it('seeds on first read and maps rows to the wire shape', async () => {
    repo.list.mockResolvedValue({ items: [rowHealthy], total: 1, summary: FULL_SUMMARY });
    const { items, total } = await service.list(PAGE);
    expect(repo.ensureSeeded).toHaveBeenCalledTimes(1);
    expect(total).toBe(1);
    expect(items[0]).toEqual({
      id: rowHealthy.id,
      name: 'ODP-JEP-01',
      area: 'Jepara',
      splitter: '1:16',
      totalPorts: 16,
      usedPorts: 2,
      avgRxPowerDbm: -18,
      status: 'healthy',
    });
  });

  // --- summary invariants ----------------------------------------------------

  describe('summary invariants', () => {
    it('summary self-consistency: totalOdp matches combined fleet', async () => {
      repo.list.mockResolvedValue({
        items: [rowHealthy, rowWarning, rowCritical],
        total: 3,
        summary: FULL_SUMMARY,
      });
      const { summary } = await service.list(PAGE);
      expect(summary.totalOdp).toBe(3);
      expect(summary.available).toBe(2);
      expect(summary.full).toBeGreaterThanOrEqual(0);
      expect(summary.optical).toBeGreaterThanOrEqual(0);
      // optical (non-healthy) must be <= totalOdp
      expect(summary.optical).toBeLessThanOrEqual(summary.totalOdp);
      // available + full must equal totalOdp (every ODP is one or the other)
      expect(summary.available + summary.full).toBe(summary.totalOdp);
    });

    it('utilization is clamped: 0 ≤ utilization ≤ 100', async () => {
      repo.list.mockResolvedValue({
        items: [rowHealthy, rowWarning, rowCritical],
        total: 3,
        summary: FULL_SUMMARY,
      });
      const { summary } = await service.list(PAGE);
      expect(summary.utilization).toBeGreaterThanOrEqual(0);
      expect(summary.utilization).toBeLessThanOrEqual(100);
    });

    it('summary is invariant when q narrows the item list (repo returns same summary)', async () => {
      // Simulate q='Jepara': only rowHealthy in items, but repo still returns full-set summary.
      repo.list.mockResolvedValue({
        items: [rowHealthy],
        total: 1,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ q: 'Jepara', ...PAGE });
      // items/total filtered, but summary is unchanged (full-fleet invariant)
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.summary).toEqual(FULL_SUMMARY);
    });

    it('summary is invariant under paging (repo always returns full-fleet summary)', async () => {
      // Page 2 of 3 (limit=1, offset=1)
      repo.list.mockResolvedValue({
        items: [rowWarning],
        total: 3,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ limit: 1, offset: 1 });
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(3); // count after q/view, before paging
      expect(result.summary).toEqual(FULL_SUMMARY);
    });

    it('summary is invariant under view=optical (repo always returns full-fleet summary)', async () => {
      // view=optical: only warning + critical returned in items
      repo.list.mockResolvedValue({
        items: [rowWarning, rowCritical],
        total: 2,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ view: 'optical', ...PAGE });
      expect(result.total).toBe(2); // filtered by view
      expect(result.summary).toEqual(FULL_SUMMARY); // summary is full-fleet
    });
  });

  // --- view predicates -------------------------------------------------------

  describe('view predicates', () => {
    it('view=available passes filter to repo and returns only ODP with free ports', async () => {
      // rowHealthy (16-2=14 free), rowCritical (8-4=4 free) — rowWarning excluded (full)
      repo.list.mockResolvedValue({
        items: [rowHealthy, rowCritical],
        total: 2,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ view: 'available', ...PAGE });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ view: 'available' }));
      expect(result.total).toBe(2);
      // Every returned item must have at least one free port
      for (const item of result.items) {
        expect(item.totalPorts - item.usedPorts).toBeGreaterThan(0);
      }
    });

    it('view=full passes filter to repo and returns only ODP with no free ports', async () => {
      // Only rowWarning (8-8=0)
      repo.list.mockResolvedValue({
        items: [rowWarning],
        total: 1,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ view: 'full', ...PAGE });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ view: 'full' }));
      expect(result.total).toBe(1);
      for (const item of result.items) {
        expect(item.totalPorts - item.usedPorts).toBe(0);
      }
    });

    it('view=optical passes filter to repo and returns only non-healthy ODP', async () => {
      // rowWarning (warning) + rowCritical (critical)
      repo.list.mockResolvedValue({
        items: [rowWarning, rowCritical],
        total: 2,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ view: 'optical', ...PAGE });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ view: 'optical' }));
      expect(result.total).toBe(2);
      for (const item of result.items) {
        expect(item.status).not.toBe('healthy');
      }
    });

    it('absent view passes no view to repo and returns all ODP', async () => {
      repo.list.mockResolvedValue({
        items: [rowHealthy, rowWarning, rowCritical],
        total: 3,
        summary: FULL_SUMMARY,
      });
      const result = await service.list(PAGE);
      // When view is absent from the filter, no view key is present in the call.
      const calledWith = repo.list.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(calledWith).not.toHaveProperty('view');
      expect(result.total).toBe(3);
    });
  });

  // --- search (q) ------------------------------------------------------------

  describe('search (q)', () => {
    it('passes q to repo for name-based search', async () => {
      repo.list.mockResolvedValue({
        items: [rowHealthy],
        total: 1,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ q: 'JEP', ...PAGE });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'JEP' }));
      expect(result.total).toBe(1);
      expect(result.items[0]?.name).toContain('JEP');
    });

    it('passes q to repo for area-based search', async () => {
      repo.list.mockResolvedValue({
        items: [rowWarning],
        total: 1,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ q: 'Tahunan', ...PAGE });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'Tahunan' }));
      expect(result.items[0]?.area).toBe('Tahunan');
    });
  });

  // --- sort ------------------------------------------------------------------

  describe('sort', () => {
    it('passes sort=name asc to repo (default direction)', async () => {
      repo.list.mockResolvedValue({
        items: [rowHealthy, rowCritical, rowWarning],
        total: 3,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ sort: 'name', order: 'asc', ...PAGE });
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'name', order: 'asc' }),
      );
      // JEP < PEC < TAH alphabetically
      expect(result.items[0]?.name).toBe('ODP-JEP-01');
    });

    it('passes sort=usedPorts asc to repo', async () => {
      // asc: rowHealthy(2), rowCritical(4), rowWarning(8)
      repo.list.mockResolvedValue({
        items: [rowHealthy, rowCritical, rowWarning],
        total: 3,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ sort: 'usedPorts', order: 'asc', ...PAGE });
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'usedPorts', order: 'asc' }),
      );
      expect(result.items[0]?.usedPorts).toBe(2);
      expect(result.items[2]?.usedPorts).toBe(8);
    });

    it('passes sort=usedPorts desc to repo', async () => {
      // desc: rowWarning(8), rowCritical(4), rowHealthy(2)
      repo.list.mockResolvedValue({
        items: [rowWarning, rowCritical, rowHealthy],
        total: 3,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ sort: 'usedPorts', order: 'desc', ...PAGE });
      expect(result.items[0]?.usedPorts).toBe(8);
      expect(result.items[2]?.usedPorts).toBe(2);
    });

    it('passes sort=avgRxPowerDbm asc to repo', async () => {
      // asc: rowHealthy(-18), rowWarning(-26), rowCritical(-28)
      repo.list.mockResolvedValue({
        items: [rowHealthy, rowWarning, rowCritical],
        total: 3,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ sort: 'avgRxPowerDbm', order: 'asc', ...PAGE });
      expect(repo.list).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'avgRxPowerDbm', order: 'asc' }),
      );
      expect(result.items[0]?.avgRxPowerDbm).toBe(-18);
    });

    it('passes sort=avgRxPowerDbm desc to repo', async () => {
      // desc: rowCritical(-28), rowWarning(-26), rowHealthy(-18)
      repo.list.mockResolvedValue({
        items: [rowCritical, rowWarning, rowHealthy],
        total: 3,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ sort: 'avgRxPowerDbm', order: 'desc', ...PAGE });
      expect(result.items[0]?.avgRxPowerDbm).toBe(-28);
      expect(result.items[2]?.avgRxPowerDbm).toBe(-18);
    });
  });

  // --- pagination ------------------------------------------------------------

  describe('pagination', () => {
    it('limit/offset paging: total and summary remain full-set values', async () => {
      // Page 1 of 3 (limit=1, offset=0)
      repo.list.mockResolvedValue({
        items: [rowHealthy],
        total: 3,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ limit: 1, offset: 0 });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 1, offset: 0 }));
      expect(result.items).toHaveLength(1);
      // total = count after view+q (none here), before paging
      expect(result.total).toBe(3);
      // summary reflects the full fleet
      expect(result.summary.totalOdp).toBe(3);
    });

    it('last page (limit=1, offset=2): returns correct single item', async () => {
      repo.list.mockResolvedValue({
        items: [rowCritical],
        total: 3,
        summary: FULL_SUMMARY,
      });
      const result = await service.list({ limit: 1, offset: 2 });
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(3);
    });
  });

  // --- port reservation (P3.A.1) ---------------------------------------------

  describe('assignPort', () => {
    it('returns the updated row when the repo reserves a port', async () => {
      const updated = { ...rowHealthy, usedPorts: 3 };
      repo.assignPort.mockResolvedValue(updated);
      const result = await service.assignPort(rowHealthy.id);
      expect(repo.assignPort).toHaveBeenCalledWith(rowHealthy.id);
      expect(result).toEqual(updated);
    });

    it('throws ConflictException when the repo returns null (full or missing)', async () => {
      repo.assignPort.mockResolvedValue(null);
      await expect(service.assignPort('does-not-exist')).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when the ODP is already at capacity', async () => {
      // Simulate the guarded UPDATE matching zero rows because usedPorts = totalPorts.
      repo.assignPort.mockResolvedValue(null);
      await expect(service.assignPort(rowWarning.id)).rejects.toThrow(
        'ODP penuh atau tidak ditemukan',
      );
    });
  });

  describe('releasePort', () => {
    it('returns the updated row when the repo releases a port', async () => {
      const updated = { ...rowHealthy, usedPorts: 1 };
      repo.releasePort.mockResolvedValue(updated);
      const result = await service.releasePort(rowHealthy.id);
      expect(repo.releasePort).toHaveBeenCalledWith(rowHealthy.id);
      expect(result).toEqual(updated);
    });

    it('returns null without throwing when the ODP has no port to release', async () => {
      repo.releasePort.mockResolvedValue(null);
      const result = await service.releasePort(rowHealthy.id);
      expect(result).toBeNull();
    });
  });
});
