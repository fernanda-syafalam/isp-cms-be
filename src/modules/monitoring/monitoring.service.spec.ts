import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alert, DeviceMetric } from '../../infrastructure/database/schema/monitoring.schema';
import { TicketsService } from '../tickets/tickets.service';
import { MonitoringRepository } from './monitoring.repository';
import { MonitoringService } from './monitoring.service';

const AUTHOR = 'NOC Operator';

const metric: DeviceMetric = {
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
const alert: Alert = {
  id: '00000000-0000-4000-8000-00000000a103',
  deviceId: '00000000-0000-4000-8000-0000000d1003',
  deviceName: 'MikroTik-Bangsri',
  severity: 'critical',
  message: 'Perangkat tidak merespons',
  at: new Date('2026-06-15T00:00:00.000Z'),
  acknowledged: false,
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

  it('listMetrics seeds then maps telemetry', async () => {
    repo.listMetrics.mockResolvedValue({ items: [metric], total: 1 });
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
});
