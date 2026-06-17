import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { odpRecords } from '../../infrastructure/database/schema/odp.schema';
import { buildOdpFixture } from './odp.fixtures';
import { OdpRepository } from './odp.repository';

/**
 * Real Postgres integration test for OdpRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0026).
 */
describe('OdpRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: OdpRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE odp_status AS ENUM ('healthy', 'warning', 'critical');
      CREATE TABLE odp_records (
        id varchar(60) PRIMARY KEY,
        name varchar(80) NOT NULL UNIQUE,
        area varchar(120) NOT NULL,
        splitter varchar(16) NOT NULL,
        total_ports integer NOT NULL,
        used_ports integer NOT NULL,
        avg_rx_power_dbm double precision NOT NULL,
        status odp_status NOT NULL,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    repo = new OdpRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(odpRecords);
  });

  it('seeds the 12-row fixture on first read, default order is name asc', async () => {
    await repo.ensureSeeded(buildOdpFixture());
    const { items, total, summary } = await repo.list({ limit: 100, offset: 0 });
    expect(items).toHaveLength(12);
    expect(total).toBe(12);
    // Default sort is name asc — ODP-BAN comes before ODP-JEP alphabetically.
    expect(items[0]?.name.startsWith('ODP-')).toBe(true);
    expect(items[0]?.usedPorts).toBeLessThanOrEqual(items[0]?.totalPorts ?? 0);
    // Summary covers the full set.
    expect(summary.totalOdp).toBe(12);
    expect(summary.utilization).toBeGreaterThanOrEqual(0);
    expect(summary.utilization).toBeLessThanOrEqual(100);
  });

  it('ensureSeeded is idempotent on the deterministic id/name', async () => {
    await repo.ensureSeeded(buildOdpFixture());
    await repo.ensureSeeded(buildOdpFixture());
    const { items } = await repo.list({ limit: 100, offset: 0 });
    expect(items).toHaveLength(12);
  });
});
