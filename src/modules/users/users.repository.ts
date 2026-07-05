import { Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import { type NewUser, type User, users } from '../../infrastructure/database/schema/users.schema';

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

// Transaction-scoped advisory-lock key that serializes concurrent first-run
// bootstrap attempts (arbitrary constant, unique to this operation).
const BOOTSTRAP_LOCK_KEY = 4_820_113;

interface CursorPayload {
  id: string;
  createdAt: string; // ISO 8601
}

/**
 * The only place in the application that talks to the `users` table.
 * Service consumers receive domain types (User / NewUser) — never
 * Drizzle row tuples or raw SQL. See Pilar 3.
 */
@Injectable()
export class UsersRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async create(input: NewUser): Promise<User> {
    const [row] = await this.db.insert(users).values(input).returning();
    if (!row) {
      // Returning() can in theory yield no row only on a hard insert
      // failure that did not throw — defensive guard.
      throw new Error('users.insert returned no row');
    }
    return row;
  }

  /**
   * Count every row in the table, INCLUDING soft-deleted ones. Used by the
   * first-run bootstrap gate: if the sole admin is later soft-deleted the
   * table is not "empty", so a stranger must not be able to re-bootstrap.
   */
  async countAll(): Promise<number> {
    const [row] = await this.db.select({ value: count() }).from(users);
    return row?.value ?? 0;
  }

  /**
   * Count non-deleted users whose role is one of `roles`. Onboarding also
   * inserts `role: 'customer'` rows into this table (portal login), so
   * `countAll()` alone cannot answer "how many staff/admin accounts exist" —
   * used by the setup-status rollup (P3.E.2) to tell the bootstrap admin
   * apart from a real staff team.
   */
  async countByRoles(roles: User['role'][]): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(users)
      .where(and(inArray(users.role, roles), isNull(users.deletedAt)));
    return row?.value ?? 0;
  }

  /**
   * Insert the given user ONLY if the table is currently empty (first-run
   * bootstrap). Runs under a transaction-scoped advisory lock so two
   * concurrent bootstrap requests serialize and only one admin is created.
   * Returns the created user, or null if any user already exists.
   */
  async createIfEmpty(input: NewUser): Promise<User | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);
      const [existing] = await tx.select({ value: count() }).from(users);
      if ((existing?.value ?? 0) > 0) return null;
      const [row] = await tx.insert(users).values(input).returning();
      return row ?? null;
    });
  }

  /**
   * Cursor-paginated list ordered by createdAt DESC, id DESC. The
   * composite key handles the edge case where two users share a
   * created_at timestamp — sorting by createdAt alone is unstable.
   */
  async listPage(cursor: string | undefined, limit: number): Promise<CursorPage<User>> {
    const decoded = cursor ? decodeCursor(cursor) : null;
    const cursorPredicate = decoded
      ? or(
          lt(users.createdAt, new Date(decoded.createdAt)),
          and(eq(users.createdAt, new Date(decoded.createdAt)), lt(users.id, decoded.id)),
        )
      : undefined;

    const rows = await this.db
      .select()
      .from(users)
      .where(and(isNull(users.deletedAt), cursorPredicate))
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit + 1);

    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const hasMore = rows.length > limit;
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }

  /**
   * Patch the mutable profile fields of a non-deleted user. Bumps
   * updated_at. Throws NotFound when the id is absent or soft-deleted so
   * the service never has to re-query to detect a missing row.
   */
  async update(id: string, patch: Partial<Pick<NewUser, 'fullName' | 'role'>>): Promise<User> {
    const [row] = await this.db
      .update(users)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .returning();
    if (!row) {
      throw new NotFoundException('user not found');
    }
    return row;
  }

  /**
   * Swap the credential hash of a non-deleted user. Separate from
   * update() on purpose — the generic profile patch must never be able
   * to touch the credential (mass-assignment boundary).
   */
  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    const result = await this.db
      .update(users)
      .set({ passwordHash, updatedAt: sql`now()` })
      .where(and(eq(users.id, id), isNull(users.deletedAt)));
    if (result.rowCount === 0) {
      throw new NotFoundException('user not found');
    }
  }

  async softDelete(id: string): Promise<void> {
    const result = await this.db
      .update(users)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(users.id, id), isNull(users.deletedAt)));
    if (result.rowCount === 0) {
      throw new NotFoundException('user not found');
    }
  }
}

function encodeCursor(u: Pick<User, 'id' | 'createdAt'>): string {
  const payload: CursorPayload = {
    id: u.id,
    createdAt: u.createdAt.toISOString(),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(s: string): CursorPayload {
  return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as CursorPayload;
}
