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
});
