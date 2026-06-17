import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type Alert,
  type DeviceMetric,
  type NewAlert,
  type NewDeviceMetric,
  alerts,
  deviceMetrics,
} from '../../infrastructure/database/schema/monitoring.schema';

export interface MetricSummary {
  up: number;
  degraded: number;
  down: number;
  total: number;
  avgUptimePct: number;
}

export interface MetricListFilter {
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface AlertListFilter {
  limit: number;
  offset: number;
}

// Columns the frontend may sort metrics on (camelCase key → Drizzle column).
// Unknown/absent key falls back to `name asc` via buildOrderBy — never throws.
const METRIC_SORT_WHITELIST = {
  name: deviceMetrics.name,
  status: deviceMetrics.status,
  uptimePct: deviceMetrics.uptimePct,
  latencyMs: deviceMetrics.latencyMs,
  utilizationPct: deviceMetrics.utilizationPct,
} satisfies Record<string, (typeof deviceMetrics)[keyof typeof deviceMetrics]>;

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

  async listMetrics(
    filter: MetricListFilter,
  ): Promise<{ items: DeviceMetric[]; total: number; summary: MetricSummary }> {
    // WHERE clause for q — applied to items and filtered total, but NOT to summary.
    const where = filter.q
      ? or(
          ilike(deviceMetrics.name, `%${filter.q}%`),
          ilike(deviceMetrics.areaName, `%${filter.q}%`),
        )
      : undefined;

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      METRIC_SORT_WHITELIST,
      asc(deviceMetrics.name),
    );

    const items = await this.db
      .select()
      .from(deviceMetrics)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);

    const [filteredCount] = await this.db
      .select({ value: count() })
      .from(deviceMetrics)
      .where(where);

    // Full-set summary — computed over ALL device_metrics rows, ignoring q/sort/paging.
    // This is the fleet-health invariant: searching or paging must not change it.
    const [summaryRow] = await this.db
      .select({
        total: count(),
        up: sql<number>`count(*) filter (where ${deviceMetrics.status} = 'up')`,
        degraded: sql<number>`count(*) filter (where ${deviceMetrics.status} = 'degraded')`,
        down: sql<number>`count(*) filter (where ${deviceMetrics.status} = 'down')`,
        avgUptimePct: sql<number>`coalesce(avg(${deviceMetrics.uptimePct}), 0)`,
      })
      .from(deviceMetrics);

    const summary: MetricSummary = {
      up: Number(summaryRow?.up ?? 0),
      degraded: Number(summaryRow?.degraded ?? 0),
      down: Number(summaryRow?.down ?? 0),
      total: summaryRow?.total ?? 0,
      // Round to 1 decimal place as required by the contract.
      avgUptimePct: Math.round(Number(summaryRow?.avgUptimePct ?? 0) * 10) / 10,
    };

    return { items, total: filteredCount?.value ?? 0, summary };
  }

  async listAlerts(filter: AlertListFilter): Promise<{ items: Alert[]; total: number }> {
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

  // --- Analytics support ----------------------------------------------

  /** Open NOC alerts not yet acknowledged — the dashboard "alerts" badge. */
  async countUnacknowledged(): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(alerts)
      .where(eq(alerts.acknowledged, false));
    return row?.value ?? 0;
  }
}
