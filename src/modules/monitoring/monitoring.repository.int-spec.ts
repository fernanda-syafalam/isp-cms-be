import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { alerts, deviceMetrics } from '../../infrastructure/database/schema/monitoring.schema';
import { MonitoringRepository } from './monitoring.repository';

/**
 * Real Postgres integration test for MonitoringRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0019).
 */
describe('MonitoringRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: MonitoringRepository;

  const D2 = '00000000-0000-4000-8000-0000000d1002';
  const D3 = '00000000-0000-4000-8000-0000000d1003';
  const A2 = '00000000-0000-4000-8000-00000000a102';
  const A3 = '00000000-0000-4000-8000-00000000a103';
  const METRICS = [
    {
      deviceId: D2,
      name: 'ONU-Pecangaan-12',
      type: 'onu',
      areaName: 'Pecangaan',
      status: 'degraded' as const,
      uptimePct: 98.2,
      latencyMs: 35,
      utilizationPct: 81,
    },
    {
      deviceId: D3,
      name: 'MikroTik-Bangsri',
      type: 'mikrotik',
      areaName: 'Bangsri',
      status: 'down' as const,
      uptimePct: 90.5,
      latencyMs: 0,
      utilizationPct: 0,
    },
  ];
  const ALERTS = [
    {
      id: A2,
      deviceId: D2,
      deviceName: 'ONU-Pecangaan-12',
      severity: 'warning' as const,
      message: 'Latensi tinggi',
      at: new Date('2026-06-15T01:00:00.000Z'),
    },
    {
      id: A3,
      deviceId: D3,
      deviceName: 'MikroTik-Bangsri',
      severity: 'critical' as const,
      message: 'Tidak merespons',
      at: new Date('2026-06-15T02:00:00.000Z'),
    },
  ];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE metric_status AS ENUM ('up', 'degraded', 'down');
      CREATE TYPE alert_severity AS ENUM ('warning', 'critical');
      CREATE TABLE device_metrics (
        device_id uuid PRIMARY KEY,
        name varchar(120) NOT NULL, type varchar(40) NOT NULL, area_name varchar(120) NOT NULL,
        status metric_status NOT NULL, uptime_pct real NOT NULL,
        latency_ms integer NOT NULL, utilization_pct integer NOT NULL,
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TABLE alerts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        device_id uuid NOT NULL, device_name varchar(120) NOT NULL,
        severity alert_severity NOT NULL, message varchar(255) NOT NULL,
        at timestamptz(3) NOT NULL DEFAULT now(), acknowledged boolean NOT NULL DEFAULT false
      );
    `);

    repo = new MonitoringRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(alerts);
    await db.delete(deviceMetrics);
  });

  it('ensureSeeded is idempotent on metric + alert keys', async () => {
    await repo.ensureSeeded(METRICS, ALERTS);
    await repo.ensureSeeded(METRICS, ALERTS);
    expect((await repo.listMetrics({ limit: 50, offset: 0 })).total).toBe(2);
    expect((await repo.listAlerts({ limit: 50, offset: 0 })).total).toBe(2);
  });

  it('lists alerts newest-first', async () => {
    await repo.ensureSeeded(METRICS, ALERTS);
    const list = await repo.listAlerts({ limit: 50, offset: 0 });
    expect(list.items.map((a) => a.severity)).toEqual(['critical', 'warning']);
  });

  it('acknowledge flips the flag and rejects a missing alert', async () => {
    await repo.ensureSeeded(METRICS, ALERTS);
    await repo.acknowledge(A2);
    const found = await repo.findAlertById(A2);
    expect(found?.acknowledged).toBe(true);
    await expect(repo.acknowledge('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });
});
