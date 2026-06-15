import { Injectable } from '@nestjs/common';
import { asc } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewOdpRecord,
  type OdpRecordRow,
  odpRecords,
} from '../../infrastructure/database/schema/odp.schema';

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

  // Ordered by id so the response preserves the fixture (index) order.
  list(): Promise<OdpRecordRow[]> {
    return this.db.select().from(odpRecords).orderBy(asc(odpRecords.id));
  }
}
