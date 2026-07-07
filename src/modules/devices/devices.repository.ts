import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, ilike, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type Device,
  type NewDevice,
  devices,
} from '../../infrastructure/database/schema/devices.schema';
import type { DeviceSummary } from './dto/device-response.dto';

export interface DeviceListFilter {
  q?: string;
  type?: Device['type'];
  status?: Device['status'];
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

// Columns the frontend is allowed to sort on (camelCase key → Drizzle column).
// Extend this map as new sortable columns are added; never pass arbitrary
// column references — the whitelist is the security boundary.
const SORT_WHITELIST = {
  name: devices.name,
  status: devices.status,
  rxPower: devices.rxPower,
  uptimeHours: devices.uptimeHours,
  lastSeenAt: devices.lastSeenAt,
} satisfies Record<string, (typeof devices)[keyof typeof devices]>;

// Fields a PATCH may correct directly.
export type DevicePatch = Partial<Pick<NewDevice, 'name' | 'ipAddress' | 'areaName'>>;

/**
 * The only place that talks to the `devices` table. Returns domain rows —
 * never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class DevicesRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  // Seed the reference fleet on first read (idempotent — name is unique).
  async ensureSeeded(defaults: NewDevice[]): Promise<void> {
    if (defaults.length === 0) return;
    await this.db.insert(devices).values(defaults).onConflictDoNothing();
  }

  async list(
    filter: DeviceListFilter,
  ): Promise<{ items: Device[]; total: number; summary: DeviceSummary }> {
    const where = and(
      filter.type ? eq(devices.type, filter.type) : undefined,
      filter.status ? eq(devices.status, filter.status) : undefined,
      filter.q
        ? or(
            ilike(devices.name, `%${filter.q}%`),
            ilike(devices.ipAddress, `%${filter.q}%`),
            ilike(devices.areaName, `%${filter.q}%`),
          )
        : undefined,
    );

    const orderBy = buildOrderBy(filter.sort, filter.order, SORT_WHITELIST, asc(devices.name));

    const items = await this.db
      .select()
      .from(devices)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(devices).where(where);

    // Full-set status-count rollup — computed over ALL devices, ignoring
    // type/status/q/paging (mirrors the work-orders/invoices summary
    // aggregate). A single grouped-filter aggregate avoids 3 separate COUNT
    // queries; missing statuses are zero-filled below.
    const [summaryRow] = await this.db
      .select({
        total: count(),
        online: sql<number>`count(*) filter (where ${devices.status} = 'online')`,
        degraded: sql<number>`count(*) filter (where ${devices.status} = 'degraded')`,
        offline: sql<number>`count(*) filter (where ${devices.status} = 'offline')`,
      })
      .from(devices);

    const summary: DeviceSummary = {
      total: summaryRow?.total ?? 0,
      byStatus: {
        online: Number(summaryRow?.online ?? 0),
        degraded: Number(summaryRow?.degraded ?? 0),
        offline: Number(summaryRow?.offline ?? 0),
      },
    };

    return { items, total: totals?.value ?? 0, summary };
  }

  async findById(id: string): Promise<Device | null> {
    const [row] = await this.db.select().from(devices).where(eq(devices.id, id)).limit(1);
    return row ?? null;
  }

  async update(id: string, patch: DevicePatch): Promise<Device> {
    const [row] = await this.db
      .update(devices)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(devices.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('device not found');
    }
    return row;
  }

  // Refresh last_seen_at — a device that just rebooted has checked back in.
  async touchLastSeen(id: string): Promise<Device> {
    const [row] = await this.db
      .update(devices)
      .set({ lastSeenAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(devices.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('device not found');
    }
    return row;
  }

  async remove(id: string): Promise<void> {
    const result = await this.db.delete(devices).where(eq(devices.id, id));
    if (result.rowCount === 0) {
      throw new NotFoundException('device not found');
    }
  }

  // --- Analytics support ----------------------------------------------

  /** Device counts grouped by status (every status present). Powers the
   * dashboard "devices online / total" KPI. */
  async countByStatus(): Promise<Record<Device['status'], number>> {
    const rows = await this.db
      .select({ status: devices.status, value: count() })
      .from(devices)
      .groupBy(devices.status);
    const result: Record<Device['status'], number> = {
      online: 0,
      degraded: 0,
      offline: 0,
    };
    for (const row of rows) {
      result[row.status] = row.value;
    }
    return result;
  }
}
