import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type Announcement,
  type NewAnnouncement,
  announcements,
} from '../../infrastructure/database/schema/announcements.schema';

/**
 * The only place that talks to the `announcements` table. Returns domain
 * rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class AnnouncementsRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  // Seed the announcement fixture on first read (idempotent — id is
  // deterministic, so onConflictDoNothing makes a re-run a no-op).
  async ensureSeeded(defaults: NewAnnouncement[]): Promise<void> {
    if (defaults.length === 0) return;
    await this.db.insert(announcements).values(defaults).onConflictDoNothing();
  }

  /**
   * Portal-facing feed: active AND (no lower bound OR already started) AND
   * (no upper bound OR not yet ended). Newest first.
   */
  async listActive(): Promise<Announcement[]> {
    const now = new Date();
    return this.db
      .select()
      .from(announcements)
      .where(
        and(
          eq(announcements.active, true),
          or(isNull(announcements.startsAt), lte(announcements.startsAt, now)),
          or(isNull(announcements.endsAt), gte(announcements.endsAt, now)),
        ),
      )
      .orderBy(desc(announcements.createdAt));
  }

  /** Full admin list — every row regardless of active/window, newest first. */
  async list(): Promise<Announcement[]> {
    return this.db.select().from(announcements).orderBy(desc(announcements.createdAt));
  }

  async create(input: NewAnnouncement): Promise<Announcement> {
    const [row] = await this.db.insert(announcements).values(input).returning();
    if (!row) {
      throw new Error('announcements.insert returned no row');
    }
    return row;
  }

  /** Soft-disable — the row stays for history, `active` flips to false. Null when the id does not exist. */
  async deactivate(id: string): Promise<Announcement | null> {
    const [row] = await this.db
      .update(announcements)
      .set({ active: false })
      .where(eq(announcements.id, id))
      .returning();
    return row ?? null;
  }
}
