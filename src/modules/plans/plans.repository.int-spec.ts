import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { PlansRepository } from './plans.repository';

/**
 * Real Postgres integration test for PlansRepository. Requires Docker.
 * Schema is applied by hand so the test runs against any commit without
 * first regenerating drizzle SQL.
 */
describe('PlansRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: PlansRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE plan_status AS ENUM ('active', 'archived');
      CREATE TABLE plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(80) NOT NULL,
        speed_mbps integer NOT NULL,
        price_monthly integer NOT NULL,
        status plan_status NOT NULL DEFAULT 'active',
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE INDEX plans_name_idx ON plans (name);
    `);

    const drizzleStub = { db } as Pick<DrizzleService, 'db'>;
    repo = new PlansRepository(drizzleStub as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(plans);
  });

  it('creates and lists plans alphabetically', async () => {
    await repo.create({ name: 'Zeta', speedMbps: 10, priceMonthly: 100_000 });
    await repo.create({ name: 'Alpha', speedMbps: 20, priceMonthly: 200_000 });

    const all = await repo.findAll();
    expect(all.map((p) => p.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('updates price and bumps updated_at', async () => {
    const created = await repo.create({
      name: 'Home 20',
      speedMbps: 20,
      priceMonthly: 200_000,
    });
    const updated = await repo.update(created.id, { priceMonthly: 250_000 });
    expect(updated.priceMonthly).toBe(250_000);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('archives a plan (status transition, row survives)', async () => {
    const created = await repo.create({
      name: 'Old',
      speedMbps: 5,
      priceMonthly: 50_000,
    });
    const archived = await repo.archive(created.id);
    expect(archived.status).toBe('archived');
    // still listed
    expect((await repo.findAll()).some((p) => p.id === created.id)).toBe(true);
  });

  it('rejects update/archive of a missing plan', async () => {
    await expect(
      repo.update('00000000-0000-0000-0000-0000000000ff', { name: 'X' }),
    ).rejects.toThrow();
    await expect(repo.archive('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });
});
