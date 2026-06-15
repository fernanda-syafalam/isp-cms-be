import { Injectable, NotFoundException } from '@nestjs/common';
import { count, desc, eq } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type Alert,
  type DeviceMetric,
  type NewAlert,
  type NewDeviceMetric,
  alerts,
  deviceMetrics,
} from '../../infrastructure/database/schema/monitoring.schema';

export interface ListFilter {
  limit: number;
  offset: number;
}

/**
 * The only place that talks to `device_metrics` / `alerts`. Returns domain
 * rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class MonitoringRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  // Seed telemetry on first read (idempotent — metrics keyed by deviceId,
  // alerts by their fixed seed id).
  async ensureSeeded(metrics: NewDeviceMetric[], seedAlerts: NewAlert[]): Promise<void> {
    if (metrics.length > 0) {
      await this.db.insert(deviceMetrics).values(metrics).onConflictDoNothing();
    }
    if (seedAlerts.length > 0) {
      await this.db.insert(alerts).values(seedAlerts).onConflictDoNothing();
    }
  }

  async listMetrics(filter: ListFilter): Promise<{ items: DeviceMetric[]; total: number }> {
    const items = await this.db
      .select()
      .from(deviceMetrics)
      .orderBy(deviceMetrics.name)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(deviceMetrics);
    return { items, total: totals?.value ?? 0 };
  }

  async listAlerts(filter: ListFilter): Promise<{ items: Alert[]; total: number }> {
    const items = await this.db
      .select()
      .from(alerts)
      .orderBy(desc(alerts.at))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(alerts);
    return { items, total: totals?.value ?? 0 };
  }

  async findAlertById(id: string): Promise<Alert | null> {
    const [row] = await this.db.select().from(alerts).where(eq(alerts.id, id)).limit(1);
    return row ?? null;
  }

  async acknowledge(id: string): Promise<void> {
    const result = await this.db
      .update(alerts)
      .set({ acknowledged: true })
      .where(eq(alerts.id, id));
    if (result.rowCount === 0) {
      throw new NotFoundException('alert not found');
    }
  }
}
