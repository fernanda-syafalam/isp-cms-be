import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewUserSession,
  type UserSecurity,
  type UserSession,
  userSecurity,
  userSessions,
} from '../../infrastructure/database/schema/security.schema';

/**
 * The only place that talks to the `user_security` and `user_sessions`
 * tables. Returns domain rows (Pilar 3). All reads/writes are scoped to a
 * single user id — there is no cross-user query here.
 */
@Injectable()
export class SecurityRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  /** Create the per-user security row on first access (idempotent). */
  async ensureState(userId: string): Promise<void> {
    await this.db.insert(userSecurity).values({ userId }).onConflictDoNothing();
  }

  async findState(userId: string): Promise<UserSecurity | null> {
    const [row] = await this.db
      .select()
      .from(userSecurity)
      .where(eq(userSecurity.userId, userId))
      .limit(1);
    return row ?? null;
  }

  async setTwoFactor(userId: string, enabled: boolean): Promise<void> {
    await this.db
      .update(userSecurity)
      .set({ twoFactorEnabled: enabled, updatedAt: sql`now()` })
      .where(eq(userSecurity.userId, userId));
  }

  async countSessions(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(userSessions)
      .where(eq(userSessions.userId, userId));
    return row?.value ?? 0;
  }

  async seedSessions(sessions: NewUserSession[]): Promise<void> {
    if (sessions.length === 0) return;
    await this.db.insert(userSessions).values(sessions);
  }

  /** Current session first, then most-recently-active. */
  async listSessions(userId: string): Promise<UserSession[]> {
    return this.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, userId))
      .orderBy(desc(userSessions.isCurrent), desc(userSessions.lastActiveAt));
  }

  /** Revoke one session, scoped to its owner. Returns whether a row matched. */
  async deleteSession(id: string, userId: string): Promise<boolean> {
    const result = await this.db
      .delete(userSessions)
      .where(and(eq(userSessions.id, id), eq(userSessions.userId, userId)));
    return (result.rowCount ?? 0) > 0;
  }

  /** Revoke every session except the current one. */
  async deleteOtherSessions(userId: string): Promise<void> {
    await this.db
      .delete(userSessions)
      .where(and(eq(userSessions.userId, userId), eq(userSessions.isCurrent, false)));
  }
}
