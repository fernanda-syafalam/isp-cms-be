import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { type NewOdpRecord, odpRecords } from '../../infrastructure/database/schema/odp.schema';
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
    // available + full must cover every ODP (each is one or the other).
    expect(summary.available + summary.full).toBe(summary.totalOdp);
  });

  it('summary.available counts ODP with a free port, regardless of the view/q filter', async () => {
    await db.insert(odpRecords).values([
      {
        id: 'odp-a',
        name: 'ODP-A',
        area: 'Jepara',
        splitter: '1:8',
        totalPorts: 8,
        usedPorts: 2, // has a free port
        avgRxPowerDbm: -18,
        status: 'healthy',
      },
      {
        id: 'odp-b',
        name: 'ODP-B',
        area: 'Jepara',
        splitter: '1:8',
        totalPorts: 8,
        usedPorts: 8, // full, no free port
        avgRxPowerDbm: -20,
        status: 'healthy',
      },
      {
        id: 'odp-c',
        name: 'ODP-C',
        area: 'Tahunan',
        splitter: '1:16',
        totalPorts: 16,
        usedPorts: 10, // has a free port
        avgRxPowerDbm: -22,
        status: 'warning',
      },
    ] satisfies NewOdpRecord[]);

    // Filter to view=full — items narrow to 1 row, but summary stays full-set.
    const filtered = await repo.list({ view: 'full', limit: 100, offset: 0 });
    expect(filtered.total).toBe(1); // filtered count
    expect(filtered.summary.available).toBe(2); // full-set: ODP-A + ODP-C
    expect(filtered.summary.full).toBe(1); // full-set: ODP-B
  });

  it('ensureSeeded is idempotent on the deterministic id/name', async () => {
    await repo.ensureSeeded(buildOdpFixture());
    await repo.ensureSeeded(buildOdpFixture());
    const { items } = await repo.list({ limit: 100, offset: 0 });
    expect(items).toHaveLength(12);
  });

  // --- port reservation (P3.A.1, concurrency guard) --------------------------

  describe('assignPort / releasePort', () => {
    const ODP: NewOdpRecord = {
      id: 'odp-port-test-01',
      name: 'ODP-PORT-01',
      area: 'Jepara',
      splitter: '1:8',
      totalPorts: 2,
      usedPorts: 0,
      avgRxPowerDbm: -18,
      status: 'healthy',
    };

    it('assignPort increments used_ports and returns the updated row', async () => {
      await repo.ensureSeeded([ODP]);
      const updated = await repo.assignPort(ODP.id);
      expect(updated?.usedPorts).toBe(1);
    });

    it('assignPort returns null (does not exceed total) once the ODP is at capacity', async () => {
      await repo.ensureSeeded([ODP]);
      const first = await repo.assignPort(ODP.id); // 0 -> 1
      const second = await repo.assignPort(ODP.id); // 1 -> 2 (now full: total=2)
      expect(first?.usedPorts).toBe(1);
      expect(second?.usedPorts).toBe(2);

      // At capacity: the guarded WHERE (used_ports < total_ports) matches no
      // row — this is the concurrency guard proving the UPDATE is atomic.
      const third = await repo.assignPort(ODP.id);
      expect(third).toBeNull();

      const { items } = await repo.list({ limit: 100, offset: 0 });
      const row = items.find((i) => i.id === ODP.id);
      expect(row?.usedPorts).toBe(2); // never exceeds totalPorts
    });

    it('assignPort returns null for a non-existent ODP id', async () => {
      const result = await repo.assignPort('does-not-exist');
      expect(result).toBeNull();
    });

    it('releasePort decrements used_ports', async () => {
      await repo.ensureSeeded([{ ...ODP, usedPorts: 1 }]);
      const released = await repo.releasePort(ODP.id);
      expect(released?.usedPorts).toBe(0);
    });

    it('releasePort returns null (never goes negative) when used_ports is already 0', async () => {
      await repo.ensureSeeded([{ ...ODP, usedPorts: 0 }]);
      const result = await repo.releasePort(ODP.id);
      expect(result).toBeNull();
    });
  });
});
