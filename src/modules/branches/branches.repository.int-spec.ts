import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { branches } from '../../infrastructure/database/schema/branches.schema';
import { BranchesRepository } from './branches.repository';

/**
 * Real Postgres integration test for BranchesRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0017).
 */
describe('BranchesRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: BranchesRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE branch_status AS ENUM ('active', 'inactive');
      CREATE TABLE branches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(120) NOT NULL,
        city varchar(80) NOT NULL,
        manager varchar(120) NOT NULL,
        phone varchar(20) NOT NULL,
        status branch_status NOT NULL DEFAULT 'active',
        is_head_office boolean NOT NULL DEFAULT false,
        customer_count integer NOT NULL DEFAULT 0,
        mrr integer NOT NULL DEFAULT 0,
        device_count integer NOT NULL DEFAULT 0,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    repo = new BranchesRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(branches);
  });

  const newBranch = (over: Partial<typeof branches.$inferInsert> = {}) => ({
    name: 'Cabang Pecangaan',
    city: 'Pecangaan',
    manager: 'Budi',
    phone: '0291',
    ...over,
  });

  it('creates a branch defaulting to active with zeroed roll-ups', async () => {
    const b = await repo.create(newBranch());
    expect(b.status).toBe('active');
    expect(b.isHeadOffice).toBe(false);
    expect(b.customerCount).toBe(0);
    expect(b.mrr).toBe(0);
  });

  it('lists by status with a real total and limit/offset', async () => {
    await repo.create(newBranch());
    await repo.create(newBranch({ name: 'Cabang Bangsri', status: 'inactive' }));
    await repo.create(newBranch({ name: 'Cabang Kalinyamatan', status: 'inactive' }));

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);
    const inactive = await repo.list({ status: 'inactive', limit: 50, offset: 0 });
    expect(inactive.total).toBe(2);
    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('updates fields and rejects a missing branch', async () => {
    const b = await repo.create(newBranch());
    const updated = await repo.update(b.id, { name: 'Cabang Baru', status: 'inactive' });
    expect(updated.name).toBe('Cabang Baru');
    expect(updated.status).toBe('inactive');
    await expect(
      repo.update('00000000-0000-0000-0000-0000000000ff', { city: 'X' }),
    ).rejects.toThrow();
  });
});
