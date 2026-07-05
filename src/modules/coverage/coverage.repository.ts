import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, ilike, or } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type CoverageArea,
  type NewCoverageArea,
  coverageAreas,
} from '../../infrastructure/database/schema/coverage.schema';

export interface CoverageListFilter {
  status?: CoverageArea['status'];
  type?: CoverageArea['type'];
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

// Columns the frontend is allowed to sort on (camelCase key → Drizzle column).
// Extend this map as new sortable columns are added; never pass arbitrary
// column references — the whitelist is the security boundary.
const COVERAGE_SORT_WHITELIST = {
  name: coverageAreas.name,
  region: coverageAreas.region,
  status: coverageAreas.status,
  capacity: coverageAreas.capacity,
  activeConnections: coverageAreas.activeConnections,
  type: coverageAreas.type,
} satisfies Record<string, (typeof coverageAreas)[keyof typeof coverageAreas]>;

/**
 * The only place that talks to the `coverage_areas` table. Returns domain
 * rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class CoverageRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  // Seed reference areas on first read (idempotent — name is unique).
  async ensureSeeded(defaults: NewCoverageArea[]): Promise<void> {
    if (defaults.length === 0) return;
    await this.db.insert(coverageAreas).values(defaults).onConflictDoNothing();
  }

  /**
   * Case-insensitive exact match on `name` (onboarding sends the area label
   * chosen from the coverage picker, not a search query). `ilike` with no
   * wildcard characters is an exact, case-insensitive equality check.
   */
  async findByName(name: string): Promise<CoverageArea | null> {
    const [row] = await this.db
      .select()
      .from(coverageAreas)
      .where(ilike(coverageAreas.name, name))
      .limit(1);
    return row ?? null;
  }

  async list(filter: CoverageListFilter): Promise<{ items: CoverageArea[]; total: number }> {
    const where = and(
      filter.status ? eq(coverageAreas.status, filter.status) : undefined,
      filter.type ? eq(coverageAreas.type, filter.type) : undefined,
      filter.q
        ? or(
            ilike(coverageAreas.name, `%${filter.q}%`),
            ilike(coverageAreas.region, `%${filter.q}%`),
          )
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      COVERAGE_SORT_WHITELIST,
      asc(coverageAreas.name),
    );

    const items = await this.db
      .select()
      .from(coverageAreas)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(coverageAreas).where(where);
    return { items, total: totals?.value ?? 0 };
  }
}
