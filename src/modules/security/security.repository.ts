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
 *
 * SEC-2: `SecurityService` no longer reads/writes `user_sessions` through
 * this repository — the reviewable session list + revocation are now
 * backed by the real refresh-token store (`RefreshTokenService`, Redis).
 * The `*Session*` methods below and the `user_sessions` table itself are
 * dead code kept intentionally (not dropped here — removing a table is
 * its own migration decision); a follow-up PR should drop both once
 * confirmed there is no other consumer. `user_security` (the 2FA state)
 * is still live and still goes through this repository.
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

  /**
   * Persist a freshly generated TOTP secret and start (or restart)
   * enrollment. `twoFactorEnabled` is explicitly reset to false here — a
   * stored secret alone must never gate login; only `confirmTwoFactor`
   * (after a valid code) does.
   */
  async saveTwoFactorSecret(userId: string, secret: string): Promise<void> {
    await this.db
      .update(userSecurity)
      .set({ twoFactorSecret: secret, twoFactorEnabled: false, updatedAt: sql`now()` })
      .where(eq(userSecurity.userId, userId));
  }

  /** Flip the flag on after the caller has verified a TOTP code against the stored secret. */
  async confirmTwoFactor(userId: string): Promise<void> {
    await this.db
      .update(userSecurity)
      .set({ twoFactorEnabled: true, updatedAt: sql`now()` })
      .where(eq(userSecurity.userId, userId));
  }

  /** Clear the secret and disable the flag — used by `disableTwoFactor`. */
  async clearTwoFactor(userId: string): Promise<void> {
    await this.db
      .update(userSecurity)
      .set({ twoFactorSecret: null, twoFactorEnabled: false, updatedAt: sql`now()` })
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
