import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { CustomersRepository } from '../customers/customers.repository';

/**
 * Real Postgres integration test for the usage seam
 * (CustomersRepository.findForUsage). Requires Docker. No usage table — the
 * usage list is computed in the service from this query.
 */
describe('Usage seam — CustomersRepository.findForUsage (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: CustomersRepository;
  let planId: string;

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
      CREATE TYPE customer_hold_reason AS ENUM ('overdue', 'voluntary');
      CREATE SEQUENCE customer_no_seq START WITH 9001;
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        lat double precision, lng double precision, odp_id varchar(60), billing_anchor_day smallint,
        customer_no varchar(32) NOT NULL UNIQUE DEFAULT ('CUST-' || nextval('customer_no_seq')),
        full_name varchar(120) NOT NULL, phone varchar(20) NOT NULL, email varchar(255), user_id uuid UNIQUE,
        address varchar(255) NOT NULL, area_id uuid, area_name varchar(120),
        plan_id uuid NOT NULL REFERENCES plans(id), status customer_status NOT NULL DEFAULT 'prospek', hold_reason customer_hold_reason,
        outstanding integer NOT NULL DEFAULT 0, npwp varchar(40), ktp varchar(32),
        consent_at timestamptz(3), data_deletion_requested_at timestamptz(3),
        reseller_name varchar(120), reseller_id uuid, connection jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    const [plan] = await db
      .insert(plans)
      .values({ name: 'Home 50', speedMbps: 50, priceMonthly: 350_000 })
      .returning();
    if (!plan) throw new Error('plan seed failed');
    planId = plan.id;

    repo = new CustomersRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(customers);
  });

  it('returns only aktif/isolir subscribers with plan name + speed', async () => {
    await db.insert(customers).values([
      { fullName: 'Aktif Ani', phone: '1', address: 'a', planId, status: 'aktif' },
      { fullName: 'Isolir Iwan', phone: '2', address: 'b', planId, status: 'isolir' },
      { fullName: 'Prospek Pita', phone: '3', address: 'c', planId, status: 'prospek' },
      { fullName: 'Berhenti Budi', phone: '4', address: 'd', planId, status: 'berhenti' },
    ]);

    const rows = await repo.findForUsage();
    expect(rows.map((r) => r.fullName)).toEqual(['Aktif Ani', 'Isolir Iwan']);
    expect(rows[0]?.planName).toBe('Home 50');
    expect(rows[0]?.planSpeedMbps).toBe(50);
  });
});
