import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, count, eq, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewPppProfile,
  type PppProfile,
  pppProfiles,
} from '../../infrastructure/database/schema/pppoe.schema';

type ProfilePatch = Partial<Pick<NewPppProfile, 'name' | 'rateLimit'>>;

/**
 * The only place that talks to the `ppp_profiles` table. Returns domain
 * rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class ProfilesRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async listByRouter(routerId: string): Promise<{ items: PppProfile[]; total: number }> {
    const items = await this.db
      .select()
      .from(pppProfiles)
      .where(eq(pppProfiles.routerId, routerId))
      .orderBy(asc(pppProfiles.name));
    return { items, total: items.length };
  }

  async findById(id: string): Promise<PppProfile | null> {
    const [row] = await this.db.select().from(pppProfiles).where(eq(pppProfiles.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * Count every profile across ALL routers. Used by the setup-status rollup
   * (P3.E.2) to tell "at least one router exists" apart from "profiles are
   * actually provisioned" — `listByRouter` alone cannot answer that without
   * a router id.
   */
  async countAll(): Promise<number> {
    const [row] = await this.db.select({ value: count() }).from(pppProfiles);
    return row?.value ?? 0;
  }

  async create(input: NewPppProfile): Promise<PppProfile> {
    const [row] = await this.db.insert(pppProfiles).values(input).returning();
    if (!row) {
      throw new Error('ppp_profiles.insert returned no row');
    }
    return row;
  }

  async update(id: string, patch: ProfilePatch): Promise<PppProfile> {
    const [row] = await this.db
      .update(pppProfiles)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(pppProfiles.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('profile not found');
    }
    return row;
  }

  async remove(id: string): Promise<void> {
    const result = await this.db.delete(pppProfiles).where(eq(pppProfiles.id, id));
    if (result.rowCount === 0) {
      throw new NotFoundException('profile not found');
    }
  }
}
