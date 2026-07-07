import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { coverageAreas } from '../../infrastructure/database/schema/coverage.schema';
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

  const SEEDS = [
    {
      name: 'POP Jepara',
      type: 'pop' as const,
      region: 'Jawa Tengah',
      capacity: 500,
      activeConnections: 320,
      status: 'operational' as const,
    },
    {
      name: 'Area Tahunan',
      type: 'area' as const,
      region: 'Jawa Tengah',
      capacity: 600,
      activeConnections: 380,
      status: 'maintenance' as const,
    },
    {
      name: 'POP Kudus',
      type: 'pop' as const,
      region: 'Jawa Tengah Utara',
      capacity: 400,
      activeConnections: 200,
      status: 'down' as const,
    },
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
    await repo.ensureSeeded(SEEDS);
    await repo.ensureSeeded(SEEDS);
    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);
  });

  it('filters by status + type with a real total and limit/offset', async () => {
    await repo.ensureSeeded(SEEDS);

    const operational = await repo.list({ status: 'operational', limit: 50, offset: 0 });
    expect(operational.total).toBe(1);
    expect(operational.items[0]?.name).toBe('POP Jepara');

    const areas = await repo.list({ type: 'area', limit: 50, offset: 0 });
    expect(areas.total).toBe(1);

    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  describe('list — summary aggregate', () => {
    it('summary.byStatus counts every area regardless of status/type/q filter, zero-filled', async () => {
      await repo.ensureSeeded(SEEDS);

      const filtered = await repo.list({ status: 'operational', limit: 50, offset: 0 });
      expect(filtered.total).toBe(1); // filtered total

      expect(filtered.summary).toEqual({
        total: 3,
        byStatus: { operational: 1, maintenance: 1, down: 1 },
      });
    });

    it('zero-fills every status key when the table is empty', async () => {
      const result = await repo.list({ limit: 50, offset: 0 });
      expect(result.summary).toEqual({
        total: 0,
        byStatus: { operational: 0, maintenance: 0, down: 0 },
      });
    });
  });

  describe('search (q)', () => {
    it('matches by name substring case-insensitively', async () => {
      await repo.ensureSeeded(SEEDS);

      // 'POP' matches 'POP Jepara' and 'POP Kudus'
      const result = await repo.list({ q: 'pop', limit: 50, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.items.every((a) => a.name.toLowerCase().includes('pop'))).toBe(true);
    });

    it('matches by region substring case-insensitively', async () => {
      await repo.ensureSeeded(SEEDS);

      // 'UTARA' only matches 'Jawa Tengah Utara' (POP Kudus)
      const result = await repo.list({ q: 'UTARA', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.name).toBe('POP Kudus');
    });

    it('total reflects the q filter, not the full table count', async () => {
      await repo.ensureSeeded(SEEDS);

      const result = await repo.list({ q: 'tahunan', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.name).toBe('Area Tahunan');
    });

    it('returns empty when q matches nothing', async () => {
      await repo.ensureSeeded(SEEDS);

      const result = await repo.list({ q: 'doesnotexist-xyz', limit: 50, offset: 0 });
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });

    it('combines status and q filters (AND semantics)', async () => {
      await repo.ensureSeeded(SEEDS);

      // status='operational' gives only 'POP Jepara'; q='jepara' narrows to same row
      const result = await repo.list({ status: 'operational', q: 'jepara', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.name).toBe('POP Jepara');
    });

    it('q with status combination that yields zero results', async () => {
      await repo.ensureSeeded(SEEDS);

      // status='down' is only 'POP Kudus'; q='tahunan' matches 'Area Tahunan' but not Kudus
      const result = await repo.list({ status: 'down', q: 'tahunan', limit: 50, offset: 0 });
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });

  describe('sort', () => {
    it('sorts by name ascending (the default)', async () => {
      await repo.ensureSeeded(SEEDS);

      const result = await repo.list({ sort: 'name', order: 'asc', limit: 50, offset: 0 });
      const names = result.items.map((a) => a.name);
      // Area Tahunan < POP Jepara < POP Kudus alphabetically
      expect(names).toEqual([...names].sort());
    });

    it('sorts by name descending', async () => {
      await repo.ensureSeeded(SEEDS);

      const result = await repo.list({ sort: 'name', order: 'desc', limit: 50, offset: 0 });
      const names = result.items.map((a) => a.name);
      expect(names).toEqual([...names].sort().reverse());
    });

    it('sorts by capacity ascending', async () => {
      await repo.ensureSeeded(SEEDS);

      const result = await repo.list({ sort: 'capacity', order: 'asc', limit: 50, offset: 0 });
      const capacities = result.items.map((a) => a.capacity);
      // 400, 500, 600
      expect(capacities).toEqual([400, 500, 600]);
    });

    it('sorts by activeConnections descending', async () => {
      await repo.ensureSeeded(SEEDS);

      const result = await repo.list({
        sort: 'activeConnections',
        order: 'desc',
        limit: 50,
        offset: 0,
      });
      const connections = result.items.map((a) => a.activeConnections);
      // 380, 320, 200
      expect(connections).toEqual([380, 320, 200]);
    });

    it('falls back to name asc when sort key is unknown', async () => {
      await repo.ensureSeeded(SEEDS);

      const result = await repo.list({ sort: 'notAColumn', order: 'desc', limit: 50, offset: 0 });
      // unknown key → default name asc
      const names = result.items.map((a) => a.name);
      expect(names).toEqual([...names].sort());
    });

    it('falls back to name asc when sort is absent', async () => {
      await repo.ensureSeeded(SEEDS);

      const result = await repo.list({ limit: 50, offset: 0 });
      const names = result.items.map((a) => a.name);
      expect(names).toEqual([...names].sort());
    });
  });
});
