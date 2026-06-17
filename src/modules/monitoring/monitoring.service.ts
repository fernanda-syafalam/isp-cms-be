import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  Alert,
  DeviceMetric,
  NewAlert,
  NewDeviceMetric,
} from '../../infrastructure/database/schema/monitoring.schema';
import type { TicketResponse } from '../tickets/dto/ticket-response.dto';
import { TicketsService } from '../tickets/tickets.service';
import type {
  AlertResponse,
  DeviceMetricResponse,
  MetricListResponse,
} from './dto/monitoring-response.dto';
import {
  type AlertListFilter,
  type MetricListFilter,
  MonitoringRepository,
} from './monitoring.repository';

const D1 = '00000000-0000-4000-8000-0000000d1001';
const D2 = '00000000-0000-4000-8000-0000000d1002';
const D3 = '00000000-0000-4000-8000-0000000d1003';

// Seeded telemetry until a real device-poller feeds these tables.
const DEFAULT_METRICS: NewDeviceMetric[] = [
  {
    deviceId: D1,
    name: 'OLT-Jepara-1',
    type: 'olt',
    areaName: 'Jepara',
    status: 'up',
    uptimePct: 99.9,
    latencyMs: 4,
    utilizationPct: 62,
  },
  {
    deviceId: D2,
    name: 'ONU-Pecangaan-12',
    type: 'onu',
    areaName: 'Pecangaan',
    status: 'degraded',
    uptimePct: 98.2,
    latencyMs: 35,
    utilizationPct: 81,
  },
  {
    deviceId: D3,
    name: 'MikroTik-Bangsri',
    type: 'mikrotik',
    areaName: 'Bangsri',
    status: 'down',
    uptimePct: 90.5,
    latencyMs: 0,
    utilizationPct: 0,
  },
];
const DEFAULT_ALERTS: NewAlert[] = [
  {
    id: '00000000-0000-4000-8000-00000000a102',
    deviceId: D2,
    deviceName: 'ONU-Pecangaan-12',
    severity: 'warning',
    message: 'Latensi tinggi terdeteksi',
  },
  {
    id: '00000000-0000-4000-8000-00000000a103',
    deviceId: D3,
    deviceName: 'MikroTik-Bangsri',
    severity: 'critical',
    message: 'Perangkat tidak merespons',
  },
];

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    private readonly repo: MonitoringRepository,
    // Escalating an alert creates a support ticket (cross-module).
    private readonly tickets: TicketsService,
  ) {}

  async listMetrics(filter: MetricListFilter): Promise<MetricListResponse> {
    await this.repo.ensureSeeded(DEFAULT_METRICS, DEFAULT_ALERTS);
    const { items, total, summary } = await this.repo.listMetrics(filter);
    return { items: items.map(toMetricResponse), total, summary };
  }

  async listAlerts(filter: AlertListFilter): Promise<{ items: AlertResponse[]; total: number }> {
    await this.repo.ensureSeeded(DEFAULT_METRICS, DEFAULT_ALERTS);
    const { items, total } = await this.repo.listAlerts(filter);
    return { items: items.map(toAlertResponse), total };
  }

  async acknowledge(id: string): Promise<void> {
    await this.repo.acknowledge(id);
    this.logger.log({ alertId: id }, 'alert acknowledged');
  }

  /** Escalate an alert into a high-priority NOC ticket, then acknowledge it. */
  async createTicket(id: string, author: string): Promise<TicketResponse> {
    const alert = await this.repo.findAlertById(id);
    if (!alert) throw new NotFoundException('alert not found');

    const ticket = await this.tickets.create(
      { subject: `[NOC] ${alert.message}`, customerName: alert.deviceName, priority: 'high' },
      author,
    );
    await this.repo.acknowledge(id);
    this.logger.log({ alertId: id, ticketId: ticket.id }, 'alert escalated to ticket');
    return ticket;
  }
}

function toMetricResponse(row: DeviceMetric): DeviceMetricResponse {
  return {
    deviceId: row.deviceId,
    name: row.name,
    type: row.type,
    areaName: row.areaName,
    status: row.status,
    uptimePct: row.uptimePct,
    latencyMs: row.latencyMs,
    utilizationPct: row.utilizationPct,
  };
}

function toAlertResponse(row: Alert): AlertResponse {
  return {
    id: row.id,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    severity: row.severity,
    message: row.message,
    at: row.at.toISOString(),
    acknowledged: row.acknowledged,
  };
}
