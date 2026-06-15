import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import {
  ipPools,
  simpleQueues,
} from '../../infrastructure/database/schema/mikrotik-resources.schema';
import { routers } from '../../infrastructure/database/schema/routers.schema';
import { PoolsRepository } from './pools.repository';
import { QueuesRepository } from './queues.repository';

/**
 * Real Postgres integration test for the queues + pools repos. Requires
 * Docker. Schema applied by hand (mirroring migration 0021).
 */
describe('Mikrotik resources repositories (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let queuesRepo: QueuesRepository;
  let poolsRepo: PoolsRepository;
  let routerId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE router_status AS ENUM ('online', 'offline');
      CREATE TABLE routers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(80) NOT NULL,
        address varchar(120) NOT NULL, api_port integer NOT NULL, username varchar(60) NOT NULL,
        model varchar(60) NOT NULL, version varchar(40) NOT NULL,
        status router_status NOT NULL DEFAULT 'online', secret_count integer NOT NULL DEFAULT 0,
        last_sync_at timestamptz(3) NOT NULL DEFAULT now(),
        created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TABLE simple_queues (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        router_id uuid NOT NULL REFERENCES routers(id),
        name varchar(60) NOT NULL, target varchar(60) NOT NULL, max_limit varchar(40) NOT NULL,
        created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TABLE ip_pools (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        router_id uuid NOT NULL REFERENCES routers(id),
        name varchar(60) NOT NULL, ranges varchar(120) NOT NULL,
        total_addresses integer NOT NULL DEFAULT 0, used_addresses integer NOT NULL DEFAULT 0,
        created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    const [router] = await db
      .insert(routers)
      .values({
        name: 'Core-1',
        address: '10.0.0.1',
        apiPort: 8728,
        username: 'api',
        model: 'RB5009',
        version: '7.15.3',
      })
      .returning();
    if (!router) throw new Error('router seed failed');
    routerId = router.id;

    queuesRepo = new QueuesRepository({ db } as unknown as DrizzleService);
    poolsRepo = new PoolsRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(simpleQueues);
    await db.delete(ipPools);
  });

  it('queues: create / list / update / remove', async () => {
    const made = await queuesRepo.create({
      routerId,
      name: 'Q1',
      target: '100.64.0.2',
      maxLimit: '20M/20M',
    });
    expect((await queuesRepo.listByRouter(routerId)).total).toBe(1);
    const updated = await queuesRepo.update(made.id, { maxLimit: '50M/50M' });
    expect(updated.maxLimit).toBe('50M/50M');
    await queuesRepo.remove(made.id);
    expect(await queuesRepo.findById(made.id)).toBeNull();
    await expect(queuesRepo.remove('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });

  it('pools: create / list / remove', async () => {
    const made = await poolsRepo.create({
      routerId,
      name: 'pool1',
      ranges: '10.10.0.2-10.10.0.254',
      totalAddresses: 253,
    });
    expect(made.totalAddresses).toBe(253);
    expect(made.usedAddresses).toBe(0);
    expect((await poolsRepo.listByRouter(routerId)).total).toBe(1);
    await poolsRepo.remove(made.id);
    expect(await poolsRepo.findById(made.id)).toBeNull();
    await expect(poolsRepo.remove('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });
});
