import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alert, DeviceMetric } from '../../infrastructure/database/schema/monitoring.schema';
import { TicketsService } from '../tickets/tickets.service';
import type { MetricSummary } from './monitoring.repository';
import { MonitoringRepository } from './monitoring.repository';
import { MonitoringService } from './monitoring.service';

const AUTHOR = 'NOC Operator';

const metricUp: DeviceMetric = {
  deviceId: '00000000-0000-4000-8000-0000000d1001',
  name: 'OLT-Jepara-1',
  type: 'olt',
  areaName: 'Jepara',
  status: 'up',
  uptimePct: 99.9,
  latencyMs: 4,
  utilizationPct: 62,
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};
const metricDegraded: DeviceMetric = {
  deviceId: '00000000-0000-4000-8000-0000000d1002',
  name: 'ONU-Pecangaan-12',
  type: 'onu',
  areaName: 'Pecangaan',
  status: 'degraded',
  uptimePct: 98.2,
  latencyMs: 35,
  utilizationPct: 81,
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};
const metricDown: DeviceMetric = {
  deviceId: '00000000-0000-4000-8000-0000000d1003',
  name: 'MikroTik-Bangsri',
  type: 'mikrotik',
  areaName: 'Bangsri',
  status: 'down',
  uptimePct: 90.5,
  latencyMs: 0,
  utilizationPct: 0,
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

// Backward-compat alias used by the legacy tests below.
const metric = metricDegraded;

const alert: Alert = {
  id: '00000000-0000-4000-8000-00000000a103',
  deviceId: '00000000-0000-4000-8000-0000000d1003',
  deviceName: 'MikroTik-Bangsri',
  severity: 'critical',
  message: 'Perangkat tidak merespons',
  at: new Date('2026-06-15T00:00:00.000Z'),
  acknowledged: false,
};

/** avgUptimePct for the three seed devices = (99.9 + 98.2 + 90.5) / 3 = 96.2 */
const FULL_SET_SUMMARY: MetricSummary = {
  up: 1,
  degraded: 1,
  down: 1,
  total: 3,
  avgUptimePct: 96.2,
};

describe('MonitoringService', () => {
  let service: MonitoringService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let tickets: { create: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      ensureSeeded: vi.fn(),
      listMetrics: vi.fn(),
      listAlerts: vi.fn(),
      findAlertById: vi.fn(),
      acknowledge: vi.fn(),
    };
    tickets = { create: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        MonitoringService,
        { provide: MonitoringRepository, useValue: repo },
        { provide: TicketsService, useValue: tickets },
      ],
    }).compile();
    service = moduleRef.get(MonitoringService);
  });

  // --- existing tests (unchanged behaviour) ---

  it('listMetrics seeds then maps telemetry', async () => {
    repo.listMetrics.mockResolvedValue({
      items: [metric],
      total: 1,
      summary: FULL_SET_SUMMARY,
    });
    const result = await service.listMetrics({ limit: 100, offset: 0 });
    expect(repo.ensureSeeded).toHaveBeenCalledTimes(1);
    expect(result.items[0]?.status).toBe('degraded');
    expect(result.items[0]?.uptimePct).toBeCloseTo(98.2);
  });

  it('listAlerts seeds then maps with ISO timestamp', async () => {
    repo.listAlerts.mockResolvedValue({ items: [alert], total: 1 });
    const result = await service.listAlerts({ limit: 100, offset: 0 });
    expect(result.items[0]?.at).toBe('2026-06-15T00:00:00.000Z');
    expect(result.items[0]?.acknowledged).toBe(false);
  });

  it('acknowledge delegates to the repo', async () => {
    await service.acknowledge(alert.id);
    expect(repo.acknowledge).toHaveBeenCalledWith(alert.id);
  });

  describe('createTicket', () => {
    it('escalates the alert to a high-priority NOC ticket then acknowledges it', async () => {
      repo.findAlertById.mockResolvedValue(alert);
      tickets.create.mockResolvedValue({ id: 't1', code: 'TKT-9001', priority: 'high' });

      const result = await service.createTicket(alert.id, AUTHOR);

      expect(tickets.create).toHaveBeenCalledWith(
        {
          subject: '[NOC] Perangkat tidak merespons',
          customerName: 'MikroTik-Bangsri',
          priority: 'high',
        },
        AUTHOR,
      );
      expect(repo.acknowledge).toHaveBeenCalledWith(alert.id);
      expect(result.code).toBe('TKT-9001');
    });

    it('throws 404 for an unknown alert and creates no ticket', async () => {
      repo.findAlertById.mockResolvedValue(null);
      await expect(service.createTicket('missing', AUTHOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tickets.create).not.toHaveBeenCalled();
    });
  });

  // --- new tests: pagination / search / sort / summary ---

  describe('listMetrics — summary invariants', () => {
    it('summary self-consistency: up + degraded + down === total', async () => {
      repo.listMetrics.mockResolvedValue({
        items: [metricUp, metricDegraded, metricDown],
        total: 3,
        summary: FULL_SET_SUMMARY,
      });
      const result = await service.listMetrics({ limit: 100, offset: 0 });
      const { summary } = result;
      expect(summary.up + summary.degraded + summary.down).toBe(summary.total);
    });

    it('avgUptimePct equals rounded mean of all device uptimePct values', async () => {
      // (99.9 + 98.2 + 90.5) / 3 = 96.2
      repo.listMetrics.mockResolvedValue({
        items: [metricUp, metricDegraded, metricDown],
        total: 3,
        summary: FULL_SET_SUMMARY,
      });
      const result = await service.listMetrics({ limit: 100, offset: 0 });
      expect(result.summary.avgUptimePct).toBeCloseTo(96.2, 1);
    });

    it('summary is invariant when q filters items (repo returns same summary)', async () => {
      // Simulate q='Jepara': items is narrowed, but repo still returns full-set summary.
      repo.listMetrics.mockResolvedValue({
        items: [metricUp],
        total: 1,
        summary: FULL_SET_SUMMARY,
      });
      const result = await service.listMetrics({ q: 'Jepara', limit: 100, offset: 0 });
      // items/total are filtered, summary is unchanged
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.summary).toEqual(FULL_SET_SUMMARY);
    });

    it('summary is invariant under paging (repo returns same summary regardless of offset)', async () => {
      repo.listMetrics.mockResolvedValue({
        items: [metricDown],
        total: 3,
        summary: FULL_SET_SUMMARY,
      });
      const result = await service.listMetrics({ limit: 1, offset: 2 });
      // Page 3-of-3 returns one item, but total=3 (full filtered set) and summary is full-fleet
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(3);
      expect(result.summary).toEqual(FULL_SET_SUMMARY);
    });
  });

  describe('listMetrics — search (q)', () => {
    it('passes q to the repo and returns filtered items + total', async () => {
      repo.listMetrics.mockResolvedValue({
        items: [metricDegraded],
        total: 1,
        summary: FULL_SET_SUMMARY,
      });
      const result = await service.listMetrics({ q: 'Pecangaan', limit: 100, offset: 0 });
      expect(repo.listMetrics).toHaveBeenCalledWith(expect.objectContaining({ q: 'Pecangaan' }));
      expect(result.total).toBe(1);
      expect(result.items[0]?.areaName).toBe('Pecangaan');
    });

    it('passes q to the repo for name-based search', async () => {
      repo.listMetrics.mockResolvedValue({
        items: [metricUp],
        total: 1,
        summary: FULL_SET_SUMMARY,
      });
      const result = await service.listMetrics({ q: 'OLT', limit: 100, offset: 0 });
      expect(result.items[0]?.name).toContain('OLT');
    });
  });

  describe('listMetrics — sort', () => {
    it('passes sort=uptimePct asc to the repo', async () => {
      // asc: metricDown(90.5), metricDegraded(98.2), metricUp(99.9)
      repo.listMetrics.mockResolvedValue({
        items: [metricDown, metricDegraded, metricUp],
        total: 3,
        summary: FULL_SET_SUMMARY,
      });
      const result = await service.listMetrics({
        sort: 'uptimePct',
        order: 'asc',
        limit: 100,
        offset: 0,
      });
      expect(repo.listMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'uptimePct', order: 'asc' }),
      );
      expect(result.items[0]?.uptimePct).toBe(90.5);
      expect(result.items[2]?.uptimePct).toBe(99.9);
    });

    it('passes sort=uptimePct desc to the repo', async () => {
      // desc: metricUp(99.9), metricDegraded(98.2), metricDown(90.5)
      repo.listMetrics.mockResolvedValue({
        items: [metricUp, metricDegraded, metricDown],
        total: 3,
        summary: FULL_SET_SUMMARY,
      });
      const result = await service.listMetrics({
        sort: 'uptimePct',
        order: 'desc',
        limit: 100,
        offset: 0,
      });
      expect(result.items[0]?.uptimePct).toBe(99.9);
      expect(result.items[2]?.uptimePct).toBe(90.5);
    });
  });

  describe('listMetrics — pagination', () => {
    it('limit/offset paging: total and summary remain full-set', async () => {
      // Page 1 of 3 (limit=1, offset=0)
      repo.listMetrics.mockResolvedValue({
        items: [metricUp],
        total: 3,
        summary: FULL_SET_SUMMARY,
      });
      const result = await service.listMetrics({ limit: 1, offset: 0 });
      expect(repo.listMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1, offset: 0 }),
      );
      expect(result.items).toHaveLength(1);
      // total = count after q (none here), before paging
      expect(result.total).toBe(3);
      // summary reflects the full fleet
      expect(result.summary.total).toBe(3);
    });
  });
});
