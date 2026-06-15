import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type Device,
  type NewDevice,
  devices,
} from '../../infrastructure/database/schema/devices.schema';

export interface DeviceListFilter {
  type?: Device['type'];
  status?: Device['status'];
  limit: number;
  offset: number;
}

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

  async list(filter: DeviceListFilter): Promise<{ items: Device[]; total: number }> {
    const where = and(
      filter.type ? eq(devices.type, filter.type) : undefined,
      filter.status ? eq(devices.status, filter.status) : undefined,
    );
    const items = await this.db
      .select()
      .from(devices)
      .where(where)
      .orderBy(asc(devices.name))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(devices).where(where);
    return { items, total: totals?.value ?? 0 };
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
}
