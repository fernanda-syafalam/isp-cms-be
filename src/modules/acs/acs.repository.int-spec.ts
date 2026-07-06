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
 * Schema applied by hand (mirroring migration 0020 + the ssid column added
 * in migration 0040).
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
        ssid varchar(32),
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

  describe('search (q)', () => {
    it('filters by serial substring case-insensitively', async () => {
      await repo.ensureSeeded([
        {
          serial: 'ZTEG20000001',
          customerName: 'Alpha',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
        {
          serial: 'HWTG20000001',
          customerName: 'Beta',
          model: 'Huawei HG8145',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
      ]);

      const result = await repo.list({ q: 'zteg2', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.serial).toBe('ZTEG20000001');
    });

    it('filters by customerName substring case-insensitively', async () => {
      await repo.ensureSeeded([
        {
          serial: 'ZTEG30000001',
          customerName: 'Siti Rahayu',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
        {
          serial: 'ZTEG30000002',
          customerName: 'Dewi Kusuma',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
      ]);

      const result = await repo.list({ q: 'siti', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.customerName).toBe('Siti Rahayu');
    });

    it('total reflects q filter, not the full table count', async () => {
      await repo.ensureSeeded([
        {
          serial: 'MATCH40000001',
          customerName: 'User A',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
        {
          serial: 'MATCH40000002',
          customerName: 'User B',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
        {
          serial: 'OTHER40000003',
          customerName: 'User C',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
      ]);

      const result = await repo.list({ q: 'MATCH4', limit: 50, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
    });

    it('returns empty result when q matches nothing', async () => {
      await repo.ensureSeeded([
        {
          serial: 'ZTEG50000001',
          customerName: 'Hendra',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
      ]);

      const result = await repo.list({ q: 'doesnotexist', limit: 50, offset: 0 });
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });

  describe('sort', () => {
    it('sorts by serial ascending', async () => {
      await repo.ensureSeeded([
        {
          serial: 'C-SERIAL60003',
          customerName: 'Third',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
        {
          serial: 'A-SERIAL60001',
          customerName: 'First',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
        {
          serial: 'B-SERIAL60002',
          customerName: 'Second',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
      ]);

      const result = await repo.list({ sort: 'serial', order: 'asc', limit: 50, offset: 0 });
      expect(result.items.map((d) => d.serial)).toEqual([
        'A-SERIAL60001',
        'B-SERIAL60002',
        'C-SERIAL60003',
      ]);
    });

    it('sorts by serial descending', async () => {
      await repo.ensureSeeded([
        {
          serial: 'C-SERIAL70003',
          customerName: 'Third',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
        {
          serial: 'A-SERIAL70001',
          customerName: 'First',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
        {
          serial: 'B-SERIAL70002',
          customerName: 'Second',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
      ]);

      const result = await repo.list({ sort: 'serial', order: 'desc', limit: 50, offset: 0 });
      expect(result.items.map((d) => d.serial)).toEqual([
        'C-SERIAL70003',
        'B-SERIAL70002',
        'A-SERIAL70001',
      ]);
    });

    it('falls back to serial asc when sort key is unknown', async () => {
      await repo.ensureSeeded([
        {
          serial: 'C-SERIAL80003',
          customerName: 'Third',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
        {
          serial: 'A-SERIAL80001',
          customerName: 'First',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
        {
          serial: 'B-SERIAL80002',
          customerName: 'Second',
          model: 'ZTE F670L',
          firmware: 'v1.0',
          rxPowerDbm: null,
          status: 'online' as const,
        },
      ]);

      // Unknown sort key → falls back to default asc(serial)
      const result = await repo.list({ sort: 'notAColumn', order: 'desc', limit: 50, offset: 0 });
      expect(result.items.map((d) => d.serial)).toEqual([
        'A-SERIAL80001',
        'B-SERIAL80002',
        'C-SERIAL80003',
      ]);
    });
  });

  // --- portal WiFi self-care seam (P3.C.4) ------------------------------------

  describe('findByCustomerName / setWifi', () => {
    it('resolves the device denormalized to an exact customer name match', async () => {
      await repo.ensureSeeded(DEFAULTS);
      const found = await repo.findByCustomerName('Budi');
      expect(found?.serial).toBe('ZTEG10000001');
    });

    it('returns null when no device is denormalized to that customer name', async () => {
      await repo.ensureSeeded(DEFAULTS);
      expect(await repo.findByCustomerName('Nobody')).toBeNull();
    });

    it('setWifi persists the new ssid and returns the updated row', async () => {
      await repo.ensureSeeded(DEFAULTS);
      const device = await repo.findByCustomerName('Budi');
      const updated = await repo.setWifi(device?.id ?? '', 'RumahBudi_5G');
      expect(updated?.ssid).toBe('RumahBudi_5G');

      // Persisted — a fresh read sees the same value, not just the RETURNING row.
      const reread = await repo.findByCustomerName('Budi');
      expect(reread?.ssid).toBe('RumahBudi_5G');
    });

    it('setWifi returns null for a non-existent device id', async () => {
      const result = await repo.setWifi('00000000-0000-0000-0000-0000000000ff', 'X');
      expect(result).toBeNull();
    });
  });
});
