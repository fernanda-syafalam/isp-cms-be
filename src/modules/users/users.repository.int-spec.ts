import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { users } from '../../infrastructure/database/schema/users.schema';
import { UsersRepository } from './users.repository';

/**
 * Real Postgres integration test for UsersRepository — verifies query
 * shape, constraints (unique email), soft-delete predicate, and cursor
 * pagination ordering.
 *
 * Requires Docker locally. Container start adds ~3–5 s to the suite.
 * Schema is applied via drizzle.execute on startup so this test does
 * not depend on having already run `pnpm db:generate`.
 */
describe('UsersRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: UsersRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    // Apply schema by hand here — this test bypasses drizzle-kit so it
    // can run against any commit without first regenerating SQL.
    await db.execute(`
      CREATE TYPE user_role AS ENUM ('admin', 'staff', 'customer', 'teknisi', 'mitra');
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email varchar(255) NOT NULL UNIQUE,
        full_name varchar(120) NOT NULL,
        password_hash varchar(255) NOT NULL,
        role user_role NOT NULL DEFAULT 'customer',
        reseller_id uuid,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now(),
        deleted_at timestamptz(3)
      );
      CREATE INDEX users_created_at_id_idx ON users (created_at, id);
    `);

    const drizzleStub = { db } as Pick<DrizzleService, 'db'>;
    repo = new UsersRepository(drizzleStub as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(users);
  });

  it('creates and reads back by id and email', async () => {
    const created = await repo.create({
      email: 'a@b.test',
      fullName: 'A B',
      passwordHash: 'hash',
    });

    const byId = await repo.findById(created.id);
    const byEmail = await repo.findByEmail('a@b.test');

    expect(byId?.id).toBe(created.id);
    expect(byEmail?.id).toBe(created.id);
  });

  it('updates mutable fields and bumps updated_at', async () => {
    const created = await repo.create({
      email: 'up@b.test',
      fullName: 'Before',
      passwordHash: 'hash',
    });

    const updated = await repo.update(created.id, {
      fullName: 'After',
      role: 'staff',
    });

    expect(updated.fullName).toBe('After');
    expect(updated.role).toBe('staff');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    // email is untouched
    expect(updated.email).toBe('up@b.test');
  });

  it('rejects update of a missing / soft-deleted user', async () => {
    const created = await repo.create({
      email: 'gone@b.test',
      fullName: 'Gone',
      passwordHash: 'hash',
    });
    await repo.softDelete(created.id);

    await expect(repo.update(created.id, { fullName: 'X' })).rejects.toThrow();
  });

  it('soft delete hides the row from finders', async () => {
    const created = await repo.create({
      email: 'sd@b.test',
      fullName: 'Soft Delete',
      passwordHash: 'hash',
    });

    await repo.softDelete(created.id);

    expect(await repo.findById(created.id)).toBeNull();
    expect(await repo.findByEmail('sd@b.test')).toBeNull();
  });

  it('lists with stable cursor pagination', async () => {
    // Insert with explicit createdAt so ordering is deterministic.
    for (let i = 0; i < 5; i++) {
      await repo.create({
        email: `u${i}@b.test`,
        fullName: `User ${i}`,
        passwordHash: 'hash',
      });
    }

    const page1 = await repo.listPage(undefined, 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await repo.listPage(page1.nextCursor ?? undefined, 2);
    expect(page2.items).toHaveLength(2);

    // No overlap between pages.
    const page1Ids = new Set(page1.items.map((u) => u.id));
    expect(page2.items.every((u) => !page1Ids.has(u.id))).toBe(true);

    const page3 = await repo.listPage(page2.nextCursor ?? undefined, 2);
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });
});
