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

  it('filters by q (case-insensitive) over name, city, and manager', async () => {
    await repo.create(newBranch({ name: 'Cabang Jepara', city: 'Jepara', manager: 'Slamet' }));
    await repo.create(newBranch({ name: 'Cabang Kudus', city: 'Kudus', manager: 'Adi Jepara' }));
    await repo.create(newBranch({ name: 'Cabang Pati', city: 'Pati', manager: 'Rudi' }));

    // matches on name
    const byName = await repo.list({ q: 'jepara', limit: 50, offset: 0 });
    // 'Cabang Jepara' (name) + 'Cabang Kudus' (manager 'Adi Jepara') both match
    expect(byName.total).toBe(2);

    // matches on city only
    const byCity = await repo.list({ q: 'Kudus', limit: 50, offset: 0 });
    expect(byCity.total).toBe(1);
    expect(byCity.items[0]?.name).toBe('Cabang Kudus');

    // q with no match returns empty
    const noMatch = await repo.list({ q: 'zzznomatch', limit: 50, offset: 0 });
    expect(noMatch.total).toBe(0);
    expect(noMatch.items).toHaveLength(0);
  });

  it('sorts by mrr desc', async () => {
    await repo.create(newBranch({ name: 'Branch A', mrr: 5_000_000 }));
    await repo.create(newBranch({ name: 'Branch B', mrr: 20_000_000 }));
    await repo.create(newBranch({ name: 'Branch C', mrr: 1_000_000 }));

    const result = await repo.list({ sort: 'mrr', order: 'desc', limit: 50, offset: 0 });
    expect(result.items[0]?.name).toBe('Branch B');
    expect(result.items[1]?.name).toBe('Branch A');
    expect(result.items[2]?.name).toBe('Branch C');
  });

  it('falls back to name asc for an unknown sort key', async () => {
    await repo.create(newBranch({ name: 'Zebra' }));
    await repo.create(newBranch({ name: 'Alpha' }));

    const result = await repo.list({ sort: 'unknownColumn', order: 'desc', limit: 50, offset: 0 });
    expect(result.items[0]?.name).toBe('Alpha');
    expect(result.items[1]?.name).toBe('Zebra');
  });

  it('returns a full-set summary ignoring status and q filters', async () => {
    await repo.create(newBranch({ customerCount: 100, mrr: 10_000_000 }));
    await repo.create(
      newBranch({ name: 'Cabang Dua', customerCount: 50, mrr: 5_000_000, status: 'inactive' }),
    );

    // Filter to active only — summary must still reflect ALL 2 branches.
    const result = await repo.list({ status: 'active', limit: 50, offset: 0 });
    expect(result.total).toBe(1); // filtered count
    expect(result.summary.branches).toBe(2); // full-set
    expect(result.summary.customers).toBe(150); // full-set sum
    expect(result.summary.mrr).toBe(15_000_000); // full-set sum
    expect(result.summary.byStatus).toEqual({ active: 1, inactive: 1 }); // full-set, zero-filled
  });

  it('summary customers and mrr coalesce to 0 on an empty table', async () => {
    // Table is already empty (cleared in beforeEach).
    const result = await repo.list({ limit: 50, offset: 0 });
    expect(result.summary.branches).toBe(0);
    expect(result.summary.customers).toBe(0);
    expect(result.summary.mrr).toBe(0);
    expect(result.summary.byStatus).toEqual({ active: 0, inactive: 0 });
  });

  it('summary.byStatus counts every branch regardless of the status/q filter', async () => {
    await repo.create(newBranch({ name: 'Cabang Satu', status: 'active' }));
    await repo.create(newBranch({ name: 'Cabang Dua', status: 'active' }));
    await repo.create(newBranch({ name: 'Cabang Tiga', status: 'inactive' }));

    const filtered = await repo.list({ status: 'active', q: 'Satu', limit: 50, offset: 0 });
    expect(filtered.total).toBe(1); // filtered count
    expect(filtered.summary.byStatus).toEqual({ active: 2, inactive: 1 }); // full-set
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
