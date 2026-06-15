import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type AppSettings,
  type NewAppSettings,
  appSettings,
} from '../../infrastructure/database/schema/settings.schema';

/**
 * The only place that talks to the `app_settings` table — a singleton.
 * Returns the single domain row (Pilar 3).
 */
@Injectable()
export class SettingsRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  /** Return the single settings row, seeding defaults on first read. */
  async getOrCreate(defaults: NewAppSettings): Promise<AppSettings> {
    const existing = await this.findOne();
    if (existing) return existing;
    // singleton UNIQUE makes a concurrent second insert a no-op.
    await this.db.insert(appSettings).values(defaults).onConflictDoNothing();
    const row = await this.findOne();
    if (!row) {
      throw new Error('settings row missing after seed');
    }
    return row;
  }

  /** Patch the single row (no where — there is only one). */
  async update(patch: Partial<NewAppSettings>): Promise<AppSettings> {
    const [row] = await this.db
      .update(appSettings)
      .set({ ...patch, updatedAt: sql`now()` })
      .returning();
    if (!row) {
      throw new Error('settings row missing on update');
    }
    return row;
  }

  private async findOne(): Promise<AppSettings | null> {
    const [row] = await this.db.select().from(appSettings).limit(1);
    return row ?? null;
  }
}
