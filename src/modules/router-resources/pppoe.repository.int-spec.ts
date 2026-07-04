import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { pppSecrets } from '../../infrastructure/database/schema/pppoe.schema';
import { routers } from '../../infrastructure/database/schema/routers.schema';
import { ProfilesRepository } from './profiles.repository';
import { SecretsRepository } from './secrets.repository';

/**
 * Real Postgres integration test for the PPPoE profiles + secrets repos.
 * Requires Docker. Schema applied by hand (mirroring migration 0016).
 */
describe('PPPoE repositories (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let profilesRepo: ProfilesRepository;
  let secretsRepo: SecretsRepository;
  let routerId: string;
  let profileId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE plan_status AS ENUM ('active', 'archived');
      CREATE TABLE plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(80) NOT NULL,
        speed_mbps integer NOT NULL, price_monthly integer NOT NULL,
        status plan_status NOT NULL DEFAULT 'active',
        created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE customer_status AS ENUM ('prospek', 'instalasi', 'aktif', 'isolir', 'berhenti');
      CREATE SEQUENCE customer_no_seq START WITH 9001;
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_no varchar(32) NOT NULL UNIQUE DEFAULT ('CUST-' || nextval('customer_no_seq')),
        full_name varchar(120) NOT NULL, phone varchar(20) NOT NULL, email varchar(255), user_id uuid UNIQUE,
        address varchar(255) NOT NULL, area_id uuid, area_name varchar(120),
        plan_id uuid NOT NULL REFERENCES plans(id), status customer_status NOT NULL DEFAULT 'prospek',
        outstanding integer NOT NULL DEFAULT 0, npwp varchar(40), ktp varchar(32),
        consent_at timestamptz(3), data_deletion_requested_at timestamptz(3),
        reseller_name varchar(120), connection jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE router_status AS ENUM ('online', 'offline');
      CREATE TABLE routers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(80) NOT NULL,
        address varchar(120) NOT NULL, api_port integer NOT NULL, username varchar(60) NOT NULL,
        model varchar(60) NOT NULL, version varchar(40) NOT NULL,
        status router_status NOT NULL DEFAULT 'online', secret_count integer NOT NULL DEFAULT 0,
        last_sync_at timestamptz(3) NOT NULL DEFAULT now(),
        created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TABLE ppp_profiles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        router_id uuid NOT NULL REFERENCES routers(id),
        name varchar(60) NOT NULL, rate_limit varchar(40) NOT NULL,
        is_isolir boolean NOT NULL DEFAULT false,
        created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TABLE ppp_secrets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        router_id uuid NOT NULL REFERENCES routers(id), username varchar(60) NOT NULL,
        profile_id uuid NOT NULL REFERENCES ppp_profiles(id), profile_name varchar(60) NOT NULL,
        customer_id uuid REFERENCES customers(id), customer_name varchar(120),
        disabled boolean NOT NULL DEFAULT false, comment varchar(160),
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

    profilesRepo = new ProfilesRepository({ db } as unknown as DrizzleService);
    secretsRepo = new SecretsRepository({ db } as unknown as DrizzleService);

    const profile = await profilesRepo.create({ routerId, name: 'Home20', rateLimit: '20M/20M' });
    profileId = profile.id;
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(pppSecrets);
  });

  it('profiles: create defaults isIsolir false, list, update, remove', async () => {
    const created = await profilesRepo.create({ routerId, name: 'Pro100', rateLimit: '100M/100M' });
    expect(created.isIsolir).toBe(false);

    const list = await profilesRepo.listByRouter(routerId);
    expect(list.total).toBeGreaterThanOrEqual(2);

    const updated = await profilesRepo.update(created.id, { rateLimit: '120M/120M' });
    expect(updated.rateLimit).toBe('120M/120M');

    await profilesRepo.remove(created.id);
    expect(await profilesRepo.findById(created.id)).toBeNull();
    await expect(profilesRepo.remove('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });

  it('secrets: create + list + update + remove with FK to profile', async () => {
    const created = await secretsRepo.create({
      routerId,
      username: 'cust9001',
      profileId,
      profileName: 'Home20',
    });
    expect(created.disabled).toBe(false);

    const list = await secretsRepo.listByRouter(routerId);
    expect(list.total).toBe(1);

    const updated = await secretsRepo.update(created.id, { disabled: true, comment: 'suspend' });
    expect(updated.disabled).toBe(true);
    expect(updated.comment).toBe('suspend');

    await secretsRepo.remove(created.id);
    expect(await secretsRepo.findById(created.id)).toBeNull();
    await expect(secretsRepo.remove('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });
});
