import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { type NewDevice, devices } from '../../infrastructure/database/schema/devices.schema';
import { DevicesRepository } from './devices.repository';

/**
 * Real Postgres integration test for DevicesRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0022).
 */
describe('DevicesRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: DevicesRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE device_type AS ENUM ('olt', 'onu', 'mikrotik');
      CREATE TYPE device_status AS ENUM ('online', 'degraded', 'offline');
      CREATE TABLE devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(120) NOT NULL UNIQUE,
        type device_type NOT NULL,
        ip_address varchar(60) NOT NULL,
        status device_status NOT NULL DEFAULT 'online',
        uptime_hours integer NOT NULL DEFAULT 0,
        rx_power double precision,
        area_name varchar(120) NOT NULL,
        last_seen_at timestamptz(3) NOT NULL DEFAULT now(),
        topology_node_id varchar(120),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    repo = new DevicesRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(devices);
  });

  const onu = (over: Partial<NewDevice> = {}): NewDevice => ({
    name: 'ONU-0001',
    type: 'onu',
    ipAddress: '100.64.100.2',
    status: 'online',
    uptimeHours: 100,
    rxPower: -18.5,
    areaName: 'Jepara',
    ...over,
  });

  it('seeds idempotently on name conflict', async () => {
    await repo.ensureSeeded([onu(), onu({ name: 'OLT-1', type: 'olt', rxPower: null })]);
    await repo.ensureSeeded([onu(), onu({ name: 'OLT-1', type: 'olt', rxPower: null })]);
    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(2);
  });

  it('lists with type filter, limit/offset, and a real total', async () => {
    await repo.ensureSeeded([
      onu(),
      onu({ name: 'ONU-0002' }),
      onu({ name: 'OLT-1', type: 'olt', rxPower: null }),
    ]);
    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);
    const onus = await repo.list({ type: 'onu', limit: 50, offset: 0 });
    expect(onus.total).toBe(2);
    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  describe('list — summary aggregate', () => {
    it('summary.byStatus counts every device regardless of type/status/q filter, zero-filled', async () => {
      await repo.ensureSeeded([
        onu({ status: 'online' }),
        onu({ name: 'ONU-0002', status: 'degraded' }),
        onu({ name: 'OLT-1', type: 'olt', rxPower: null, status: 'offline' }),
      ]);

      const filtered = await repo.list({ type: 'onu', limit: 50, offset: 0 });
      expect(filtered.total).toBe(2); // filtered total

      expect(filtered.summary).toEqual({
        total: 3,
        byStatus: { online: 1, degraded: 1, offline: 1 },
      });
    });

    it('zero-fills every status key when the table is empty', async () => {
      const result = await repo.list({ limit: 50, offset: 0 });
      expect(result.summary).toEqual({
        total: 0,
        byStatus: { online: 0, degraded: 0, offline: 0 },
      });
    });
  });

  it('preserves nullable rx_power and reads it back as a number', async () => {
    await repo.ensureSeeded([
      onu({ rxPower: -22.5 }),
      onu({ name: 'OLT-1', type: 'olt', rxPower: null }),
    ]);
    const { items } = await repo.list({ limit: 50, offset: 0 });
    const stored = items.find((d) => d.type === 'onu');
    const olt = items.find((d) => d.type === 'olt');
    expect(stored?.rxPower).toBe(-22.5);
    expect(olt?.rxPower).toBeNull();
  });

  it('updates correctable fields and rejects a missing device', async () => {
    await repo.ensureSeeded([onu()]);
    const [row] = (await repo.list({ limit: 1, offset: 0 })).items;
    if (!row) throw new Error('seed missing');
    const updated = await repo.update(row.id, { name: 'ONU-RENAMED', areaName: 'Tahunan' });
    expect(updated.name).toBe('ONU-RENAMED');
    expect(updated.areaName).toBe('Tahunan');
    await expect(
      repo.update('00000000-0000-0000-0000-0000000000ff', { name: 'x' }),
    ).rejects.toThrow();
  });

  it('touchLastSeen moves last_seen_at forward', async () => {
    await repo.ensureSeeded([onu({ status: 'offline' })]);
    const [row] = (await repo.list({ limit: 1, offset: 0 })).items;
    if (!row) throw new Error('seed missing');
    const touched = await repo.touchLastSeen(row.id);
    expect(touched.lastSeenAt.getTime()).toBeGreaterThanOrEqual(row.lastSeenAt.getTime());
  });

  it('removes a device and rejects a missing one', async () => {
    await repo.ensureSeeded([onu()]);
    const [row] = (await repo.list({ limit: 1, offset: 0 })).items;
    if (!row) throw new Error('seed missing');
    await repo.remove(row.id);
    expect((await repo.list({ limit: 50, offset: 0 })).total).toBe(0);
    await expect(repo.remove('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });

  it('counts devices by status with every status present', async () => {
    await repo.ensureSeeded([
      onu({ name: 'D1', status: 'online' }),
      onu({ name: 'D2', status: 'online' }),
      onu({ name: 'D3', status: 'degraded' }),
      onu({ name: 'D4', status: 'offline' }),
    ]);
    expect(await repo.countByStatus()).toEqual({ online: 2, degraded: 1, offline: 1 });
  });
});
