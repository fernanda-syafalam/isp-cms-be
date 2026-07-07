import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type AcsDevice,
  type NewAcsDevice,
  acsDevices,
} from '../../infrastructure/database/schema/acs.schema';
import type { AcsSummary } from './dto/acs-response.dto';

// Columns the frontend may sort on (camelCase key → Drizzle column).
// Unknown/absent key falls back to `serial asc` via buildOrderBy — never throws.
const ACS_SORT_WHITELIST = {
  serial: acsDevices.serial,
  customerName: acsDevices.customerName,
  model: acsDevices.model,
  firmware: acsDevices.firmware,
  rxPowerDbm: acsDevices.rxPowerDbm,
  status: acsDevices.status,
  lastInform: acsDevices.lastInform,
  createdAt: acsDevices.createdAt,
} satisfies Record<string, (typeof acsDevices)[keyof typeof acsDevices]>;

export interface AcsListFilter {
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
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

  async list(
    filter: AcsListFilter,
  ): Promise<{ items: AcsDevice[]; total: number; summary: AcsSummary }> {
    const where = and(
      filter.q
        ? or(
            ilike(acsDevices.serial, `%${filter.q}%`),
            ilike(acsDevices.customerName, `%${filter.q}%`),
          )
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      ACS_SORT_WHITELIST,
      asc(acsDevices.serial),
    );

    const items = await this.db
      .select()
      .from(acsDevices)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(acsDevices).where(where);

    // Full-set status-count rollup — computed over ALL CPE devices, ignoring
    // q/paging (mirrors the work-orders/invoices summary aggregate). A single
    // grouped-filter aggregate avoids 2 separate COUNT queries; a missing
    // status is zero-filled below since a fresh table may have zero rows for
    // a given status.
    const [summaryRow] = await this.db
      .select({
        total: count(),
        online: sql<number>`count(*) filter (where ${acsDevices.status} = 'online')`,
        offline: sql<number>`count(*) filter (where ${acsDevices.status} = 'offline')`,
      })
      .from(acsDevices);

    const summary: AcsSummary = {
      total: summaryRow?.total ?? 0,
      byStatus: {
        online: Number(summaryRow?.online ?? 0),
        offline: Number(summaryRow?.offline ?? 0),
      },
    };

    return { items, total: totals?.value ?? 0, summary };
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

  // Resolve the single CPE denormalized to a given customer name — the
  // portal WiFi self-care seam (P3.C.4). See the module header comment on
  // acs_devices for why this is a name match rather than a typed FK.
  async findByCustomerName(customerName: string): Promise<AcsDevice | null> {
    const [row] = await this.db
      .select()
      .from(acsDevices)
      .where(eq(acsDevices.customerName, customerName))
      .limit(1);
    return row ?? null;
  }

  // Persist the new WiFi SSID for a single device. Returns null when the id
  // does not exist.
  async setWifi(id: string, ssid: string): Promise<AcsDevice | null> {
    const [row] = await this.db
      .update(acsDevices)
      .set({ ssid, updatedAt: sql`now()` })
      .where(eq(acsDevices.id, id))
      .returning();
    return row ?? null;
  }
}
