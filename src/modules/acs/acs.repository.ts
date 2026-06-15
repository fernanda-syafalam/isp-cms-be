import { Injectable } from '@nestjs/common';
import { asc, count, inArray, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type AcsDevice,
  type NewAcsDevice,
  acsDevices,
} from '../../infrastructure/database/schema/acs.schema';

export interface AcsListFilter {
  limit: number;
  offset: number;
}

/**
 * The only place that talks to the `acs_devices` table. Returns domain rows —
 * never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class AcsRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  // Seed CPE inventory on first read (idempotent — serial is unique).
  async ensureSeeded(defaults: NewAcsDevice[]): Promise<void> {
    if (defaults.length === 0) return;
    await this.db.insert(acsDevices).values(defaults).onConflictDoNothing();
  }

  async list(filter: AcsListFilter): Promise<{ items: AcsDevice[]; total: number }> {
    const items = await this.db
      .select()
      .from(acsDevices)
      .orderBy(asc(acsDevices.serial))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(acsDevices);
    return { items, total: totals?.value ?? 0 };
  }

  // How many of the given ids exist (affected count for reboot / wifi).
  async countByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const [row] = await this.db
      .select({ value: count() })
      .from(acsDevices)
      .where(inArray(acsDevices.id, ids));
    return row?.value ?? 0;
  }

  // Push a firmware version to the given devices; returns rows updated.
  async updateFirmware(ids: string[], firmware: string): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.db
      .update(acsDevices)
      .set({ firmware, lastInform: sql`now()`, updatedAt: sql`now()` })
      .where(inArray(acsDevices.id, ids));
    return result.rowCount ?? 0;
  }
}
