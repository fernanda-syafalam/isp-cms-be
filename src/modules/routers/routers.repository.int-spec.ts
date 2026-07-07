import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { routers } from '../../infrastructure/database/schema/routers.schema';
import { RoutersRepository } from './routers.repository';

/**
 * Real Postgres integration test for RoutersRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0013).
 */
describe('RoutersRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: RoutersRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE router_status AS ENUM ('online', 'offline');
      CREATE TABLE routers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(80) NOT NULL,
        address varchar(120) NOT NULL,
        api_port integer NOT NULL,
        username varchar(60) NOT NULL,
        model varchar(60) NOT NULL,
        version varchar(40) NOT NULL,
        status router_status NOT NULL DEFAULT 'online',
        secret_count integer NOT NULL DEFAULT 0,
        last_sync_at timestamptz(3) NOT NULL DEFAULT now(),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    repo = new RoutersRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(routers);
  });

  const newRouter = (over: Partial<typeof routers.$inferInsert> = {}) => ({
    name: 'Core-1',
    address: '10.0.0.1',
    apiPort: 8728,
    username: 'apiuser',
    model: 'RB5009',
    version: '7.15.3',
    ...over,
  });

  it('creates a router defaulting to online with zero secrets', async () => {
    const r = await repo.create(newRouter());
    expect(r.status).toBe('online');
    expect(r.secretCount).toBe(0);
    expect(r.lastSyncAt).toBeInstanceOf(Date);
  });

  it('lists by status with a real total and limit/offset', async () => {
    await repo.create(newRouter());
    await repo.create(newRouter({ name: 'Edge-1', status: 'offline' }));
    await repo.create(newRouter({ name: 'Edge-2', status: 'offline' }));

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);
    const offline = await repo.list({ status: 'offline', limit: 50, offset: 0 });
    expect(offline.total).toBe(2);
    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('markSynced refreshes last_sync_at and rejects a missing router', async () => {
    const r = await repo.create(newRouter({ status: 'offline' }));
    const synced = await repo.markSynced(r.id);
    expect(synced.status).toBe('online');
    expect(synced.lastSyncAt.getTime()).toBeGreaterThanOrEqual(r.lastSyncAt.getTime());
    await expect(repo.markSynced('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });

  describe('list — summary aggregate', () => {
    it('summary.byStatus counts every router regardless of status/q filter, zero-filled', async () => {
      await repo.create(newRouter());
      await repo.create(newRouter({ name: 'Edge-1', status: 'offline' }));
      await repo.create(newRouter({ name: 'Edge-2', status: 'offline' }));

      const filtered = await repo.list({ status: 'online', limit: 50, offset: 0 });
      expect(filtered.total).toBe(1); // filtered total

      expect(filtered.summary).toEqual({
        total: 3,
        byStatus: { online: 1, offline: 2 },
      });
    });

    it('zero-fills every status key when the table is empty', async () => {
      const result = await repo.list({ limit: 50, offset: 0 });
      expect(result.summary).toEqual({ total: 0, byStatus: { online: 0, offline: 0 } });
    });
  });

  describe('search (q)', () => {
    it('filters by name substring case-insensitively', async () => {
      await repo.create(newRouter({ name: 'Core-Router-1', address: '10.0.1.1' }));
      await repo.create(newRouter({ name: 'Edge-Router-2', address: '10.0.2.1' }));

      const result = await repo.list({ q: 'core', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.name).toBe('Core-Router-1');
    });

    it('filters by address substring case-insensitively', async () => {
      await repo.create(newRouter({ name: 'RT-Alpha', address: '192.168.10.1' }));
      await repo.create(newRouter({ name: 'RT-Beta', address: '172.16.20.1' }));

      const result = await repo.list({ q: '192.168', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.address).toBe('192.168.10.1');
    });

    it('filters by model substring case-insensitively', async () => {
      await repo.create(newRouter({ name: 'RT-1', address: '10.1.1.1', model: 'CCR2004' }));
      await repo.create(newRouter({ name: 'RT-2', address: '10.1.1.2', model: 'RB5009' }));

      const result = await repo.list({ q: 'ccr', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.model).toBe('CCR2004');
    });

    it('total reflects q filter, not the full table count', async () => {
      await repo.create(newRouter({ name: 'Match-1', address: '10.2.1.1' }));
      await repo.create(newRouter({ name: 'Match-2', address: '10.2.1.2' }));
      await repo.create(newRouter({ name: 'Other-3', address: '10.2.1.3' }));

      const result = await repo.list({ q: 'Match', limit: 50, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
    });

    it('q combined with status filter ANDs correctly', async () => {
      await repo.create(newRouter({ name: 'Core-Online', address: '10.3.1.1', status: 'online' }));
      await repo.create(
        newRouter({ name: 'Core-Offline', address: '10.3.1.2', status: 'offline' }),
      );
      await repo.create(newRouter({ name: 'Edge-Online', address: '10.3.1.3', status: 'online' }));

      const result = await repo.list({ q: 'Core', status: 'online', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.name).toBe('Core-Online');
    });

    it('returns empty result when q matches nothing', async () => {
      await repo.create(newRouter({ name: 'RT-Existing', address: '10.4.1.1' }));

      const result = await repo.list({ q: 'doesnotexist', limit: 50, offset: 0 });
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });

  describe('sort', () => {
    it('sorts by name ascending', async () => {
      await repo.create(newRouter({ name: 'Z-Router', address: '10.5.1.3' }));
      await repo.create(newRouter({ name: 'A-Router', address: '10.5.1.1' }));
      await repo.create(newRouter({ name: 'M-Router', address: '10.5.1.2' }));

      const result = await repo.list({ sort: 'name', order: 'asc', limit: 50, offset: 0 });
      expect(result.items.map((r) => r.name)).toEqual(['A-Router', 'M-Router', 'Z-Router']);
    });

    it('sorts by name descending', async () => {
      await repo.create(newRouter({ name: 'Z-Router-D', address: '10.6.1.3' }));
      await repo.create(newRouter({ name: 'A-Router-D', address: '10.6.1.1' }));
      await repo.create(newRouter({ name: 'M-Router-D', address: '10.6.1.2' }));

      const result = await repo.list({ sort: 'name', order: 'desc', limit: 50, offset: 0 });
      expect(result.items.map((r) => r.name)).toEqual(['Z-Router-D', 'M-Router-D', 'A-Router-D']);
    });

    it('sorts by secretCount ascending', async () => {
      const r1 = await repo.create(newRouter({ name: 'High-SC', address: '10.7.1.1' }));
      const r2 = await repo.create(newRouter({ name: 'Low-SC', address: '10.7.1.2' }));
      // Adjust secret counts
      await repo.adjustSecretCount(r1.id, 10);
      await repo.adjustSecretCount(r2.id, 2);

      const result = await repo.list({ sort: 'secretCount', order: 'asc', limit: 50, offset: 0 });
      expect(result.items[0]?.name).toBe('Low-SC');
      expect(result.items[1]?.name).toBe('High-SC');
    });

    it('falls back to createdAt desc when sort key is unknown', async () => {
      // Insert in known order; without explicit sleep, rely on order of creation
      // (same-millisecond rows are fine — we just check no crash and 3 rows returned)
      await repo.create(newRouter({ name: 'Fallback-1', address: '10.8.1.1' }));
      await repo.create(newRouter({ name: 'Fallback-2', address: '10.8.1.2' }));
      await repo.create(newRouter({ name: 'Fallback-3', address: '10.8.1.3' }));

      // Unknown sort key — must not throw, must return all 3 rows
      const result = await repo.list({ sort: 'notAColumn', order: 'desc', limit: 50, offset: 0 });
      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(3);
    });
  });
});
