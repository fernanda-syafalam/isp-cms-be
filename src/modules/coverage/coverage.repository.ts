import { Injectable } from '@nestjs/common';
import { and, asc, count, eq } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type CoverageArea,
  type NewCoverageArea,
  coverageAreas,
} from '../../infrastructure/database/schema/coverage.schema';

export interface CoverageListFilter {
  status?: CoverageArea['status'];
  type?: CoverageArea['type'];
  limit: number;
  offset: number;
}

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

  async list(filter: CoverageListFilter): Promise<{ items: CoverageArea[]; total: number }> {
    const where = and(
      filter.status ? eq(coverageAreas.status, filter.status) : undefined,
      filter.type ? eq(coverageAreas.type, filter.type) : undefined,
    );
    const items = await this.db
      .select()
      .from(coverageAreas)
      .where(where)
      .orderBy(asc(coverageAreas.name))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(coverageAreas).where(where);
    return { items, total: totals?.value ?? 0 };
  }
}
