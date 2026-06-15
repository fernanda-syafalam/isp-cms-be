import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { acsDevices } from '../../infrastructure/database/schema/acs.schema';
import { AcsRepository } from './acs.repository';

/**
 * Real Postgres integration test for AcsRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0020).
 */
describe('AcsRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: AcsRepository;

  const DEFAULTS = [
    {
      serial: 'ZTEG10000001',
      customerName: 'Budi',
      model: 'ZTE F670L',
      firmware: 'v2.3.0',
      rxPowerDbm: -21.5,
      status: 'online' as const,
    },
    {
      serial: 'ZTEG10000002',
      customerName: 'Ani',
      model: 'Huawei HG8145',
      firmware: 'v2.2.8',
      rxPowerDbm: null,
      status: 'offline' as const,
    },
  ];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE acs_status AS ENUM ('online', 'offline');
      CREATE TABLE acs_devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        serial varchar(80) NOT NULL UNIQUE,
        customer_name varchar(120) NOT NULL,
        model varchar(80) NOT NULL,
        firmware varchar(40) NOT NULL,
        rx_power_dbm real,
        status acs_status NOT NULL DEFAULT 'online',
        last_inform timestamptz(3) NOT NULL DEFAULT now(),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    repo = new AcsRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(acsDevices);
  });

  it('ensureSeeded is idempotent on the serial unique key', async () => {
    await repo.ensureSeeded(DEFAULTS);
    await repo.ensureSeeded(DEFAULTS);
    expect((await repo.list({ limit: 50, offset: 0 })).total).toBe(2);
  });

  it('countByIds counts only existing ids; updateFirmware persists', async () => {
    await repo.ensureSeeded(DEFAULTS);
    const { items } = await repo.list({ limit: 50, offset: 0 });
    const ids = items.map((d) => d.id);

    expect(await repo.countByIds(ids)).toBe(2);
    expect(await repo.countByIds(['00000000-0000-0000-0000-0000000000ff'])).toBe(0);

    const updated = await repo.updateFirmware(ids, 'v2.4.1');
    expect(updated).toBe(2);
    const after = await repo.list({ limit: 50, offset: 0 });
    expect(after.items.every((d) => d.firmware === 'v2.4.1')).toBe(true);
  });
});
