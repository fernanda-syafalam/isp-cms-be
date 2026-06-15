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

  it('seeds the 12-row fixture on first read, ordered by id', async () => {
    await repo.ensureSeeded(buildOdpFixture());
    const rows = await repo.list();
    expect(rows).toHaveLength(12);
    expect(rows[0]?.name).toBe('ODP-JEP-01'); // index 0 is first by id
    expect(rows[0]?.usedPorts).toBeLessThanOrEqual(rows[0]?.totalPorts ?? 0);
  });

  it('ensureSeeded is idempotent on the deterministic id/name', async () => {
    await repo.ensureSeeded(buildOdpFixture());
    await repo.ensureSeeded(buildOdpFixture());
    const rows = await repo.list();
    expect(rows).toHaveLength(12);
  });
});
