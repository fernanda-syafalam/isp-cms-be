import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { coverageAreas } from '../../infrastructure/database/schema/coverage.schema';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { CoverageRepository } from './coverage.repository';

/**
 * Real Postgres integration test for CoverageRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0018).
 */
describe('CoverageRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: CoverageRepository;

  const DEFAULTS = [
    { name: 'POP Jepara', type: 'pop' as const, region: 'Jawa Tengah', capacity: 500, activeConnections: 320, status: 'operational' as const },
    { name: 'Area Tahunan', type: 'area' as const, region: 'Jawa Tengah', capacity: 600, activeConnections: 380, status: 'maintenance' as const },
  ];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE coverage_type AS ENUM ('pop', 'area');
      CREATE TYPE coverage_status AS ENUM ('operational', 'maintenance', 'down');
      CREATE TABLE coverage_areas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(120) NOT NULL UNIQUE,
        type coverage_type NOT NULL,
        region varchar(120) NOT NULL,
        capacity integer NOT NULL,
        active_connections integer NOT NULL DEFAULT 0,
        status coverage_status NOT NULL DEFAULT 'operational',
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    repo = new CoverageRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(coverageAreas);
  });

  it('ensureSeeded is idempotent on the name unique key', async () => {
    await repo.ensureSeeded(DEFAULTS);
    await repo.ensureSeeded(DEFAULTS);
    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(2);
  });

  it('filters by status + type with a real total and limit/offset', async () => {
    await repo.ensureSeeded(DEFAULTS);

    const operational = await repo.list({ status: 'operational', limit: 50, offset: 0 });
    expect(operational.total).toBe(1);
    expect(operational.items[0]?.name).toBe('POP Jepara');

    const areas = await repo.list({ type: 'area', limit: 50, offset: 0 });
    expect(areas.total).toBe(1);

    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
  });
});
