import { Injectable } from '@nestjs/common';
import { SQL, and, asc, count, eq, ilike, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewOdpRecord,
  type OdpRecordRow,
  odpRecords,
} from '../../infrastructure/database/schema/odp.schema';
import type { OdpSummary } from './dto/odp-response.dto';

// Columns the frontend may sort on (camelCase key → Drizzle column).
// Unknown/absent key falls back to `name asc` via buildOrderBy — never throws.
const ODP_SORT_WHITELIST = {
  name: odpRecords.name,
  usedPorts: odpRecords.usedPorts,
  avgRxPowerDbm: odpRecords.avgRxPowerDbm,
} satisfies Record<string, (typeof odpRecords)[keyof typeof odpRecords]>;

export interface OdpListFilter {
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  /** Derived capacity/health filter — evaluated as a SQL predicate. */
  view?: 'available' | 'full' | 'optical';
  limit: number;
  offset: number;
}

/**
 * The only place that talks to the `odp_records` table. Returns domain rows —
 * never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class OdpRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  // Seed the distribution-point fixture on first read (idempotent — id/name are
  // deterministic, so onConflictDoNothing makes a re-run a no-op).
  async ensureSeeded(defaults: NewOdpRecord[]): Promise<void> {
    if (defaults.length === 0) return;
    await this.db.insert(odpRecords).values(defaults).onConflictDoNothing();
  }

  async findById(id: string): Promise<OdpRecordRow | null> {
    const [row] = await this.db.select().from(odpRecords).where(eq(odpRecords.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * Atomically reserve one port on the ODP. A single guarded UPDATE — the
   * WHERE clause re-checks capacity in the same statement Postgres uses to
   * take the row lock, so two concurrent onboardings racing for the last
   * free port cannot both succeed (no read-then-write gap). Returns null
   * when the ODP is missing or already at capacity — the caller decides
   * what that means (OdpService throws 409).
   */
  async assignPort(odpId: string): Promise<OdpRecordRow | null> {
    const [row] = await this.db
      .update(odpRecords)
      .set({ usedPorts: sql`${odpRecords.usedPorts} + 1`, updatedAt: sql`now()` })
      .where(and(eq(odpRecords.id, odpId), sql`${odpRecords.usedPorts} < ${odpRecords.totalPorts}`))
      .returning();
    return row ?? null;
  }

  /**
   * Atomically release one port (e.g. a customer relocates/churns off this
   * ODP). Guarded symmetrically by `used_ports > 0` so it can never go
   * negative under concurrent releases.
   */
  async releasePort(odpId: string): Promise<OdpRecordRow | null> {
    const [row] = await this.db
      .update(odpRecords)
      .set({ usedPorts: sql`${odpRecords.usedPorts} - 1`, updatedAt: sql`now()` })
      .where(and(eq(odpRecords.id, odpId), sql`${odpRecords.usedPorts} > 0`))
      .returning();
    return row ?? null;
  }

  async list(
    filter: OdpListFilter,
  ): Promise<{ items: OdpRecordRow[]; total: number; summary: OdpSummary }> {
    // --- 1. Full-set summary (no view/q/paging) --------------------------------
    // Computed first, over ALL odp_records, so it is invariant under any filter.
    const [summaryRow] = await this.db
      .select({
        totalOdp: count(),
        sumUsed: sql<number>`coalesce(sum(${odpRecords.usedPorts}), 0)`,
        sumTotal: sql<number>`coalesce(sum(${odpRecords.totalPorts}), 0)`,
        full: sql<number>`count(*) filter (where ${odpRecords.totalPorts} - ${odpRecords.usedPorts} = 0)`,
        optical: sql<number>`count(*) filter (where ${odpRecords.status} <> 'healthy')`,
      })
      .from(odpRecords);

    const sumUsed = Number(summaryRow?.sumUsed ?? 0);
    const sumTotal = Number(summaryRow?.sumTotal ?? 0);
    const summary: OdpSummary = {
      totalOdp: summaryRow?.totalOdp ?? 0,
      utilization: sumTotal > 0 ? Math.round((sumUsed / sumTotal) * 100) : 0,
      full: Number(summaryRow?.full ?? 0),
      optical: Number(summaryRow?.optical ?? 0),
    };

    // --- 2. view predicate (capacity/health filter) ----------------------------
    const viewWhere = buildViewWhere(filter.view);

    // --- 3. q search predicate (ILIKE over name and area) ----------------------
    const searchWhere = filter.q
      ? or(ilike(odpRecords.name, `%${filter.q}%`), ilike(odpRecords.area, `%${filter.q}%`))
      : undefined;

    // Combined WHERE: view AND q (both must hold when present).
    const where =
      viewWhere && searchWhere ? and(viewWhere, searchWhere) : (viewWhere ?? searchWhere);

    // --- 4. Filtered total (after view + q, before paging) --------------------
    const [filteredCount] = await this.db.select({ value: count() }).from(odpRecords).where(where);

    // --- 5. Sort + paging -----------------------------------------------------
    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      ODP_SORT_WHITELIST,
      asc(odpRecords.name), // default: name asc
    );

    const items = await this.db
      .select()
      .from(odpRecords)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);

    return { items, total: filteredCount?.value ?? 0, summary };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts the `view` query param into a Drizzle SQL predicate.
 *
 * - `available`: ODP has at least one free port (totalPorts - usedPorts > 0)
 * - `full`:      ODP has no free port  (totalPorts - usedPorts = 0)
 * - `optical`:   ODP status is not 'healthy'
 * - absent:      no predicate (returns undefined → no WHERE clause from view)
 */
function buildViewWhere(view: OdpListFilter['view']): SQL | undefined {
  switch (view) {
    case 'available':
      return sql`${odpRecords.totalPorts} - ${odpRecords.usedPorts} > 0`;
    case 'full':
      return sql`${odpRecords.totalPorts} - ${odpRecords.usedPorts} = 0`;
    case 'optical':
      return sql`${odpRecords.status} <> 'healthy'`;
    default:
      return undefined;
  }
}
