import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { contracts } from '../../infrastructure/database/schema/contracts.schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { ContractsRepository } from './contracts.repository';

/**
 * Real Postgres integration test for ContractsRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0011).
 */
describe('ContractsRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: ContractsRepository;
  let customerId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE plan_status AS ENUM ('active', 'archived');
      CREATE TABLE plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(80) NOT NULL, speed_mbps integer NOT NULL,
        price_monthly integer NOT NULL, status plan_status NOT NULL DEFAULT 'active',
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE customer_status AS ENUM ('prospek', 'instalasi', 'aktif', 'isolir', 'berhenti');
      CREATE TYPE customer_hold_reason AS ENUM ('overdue', 'voluntary');
      CREATE SEQUENCE customer_no_seq START WITH 9001;
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        lat double precision, lng double precision, odp_id varchar(60),
        customer_no varchar(32) NOT NULL UNIQUE DEFAULT ('CUST-' || nextval('customer_no_seq')),
        full_name varchar(120) NOT NULL, phone varchar(20) NOT NULL, email varchar(255), user_id uuid UNIQUE,
        address varchar(255) NOT NULL, area_id uuid, area_name varchar(120),
        plan_id uuid NOT NULL REFERENCES plans(id),
        status customer_status NOT NULL DEFAULT 'prospek', hold_reason customer_hold_reason,
        outstanding integer NOT NULL DEFAULT 0, npwp varchar(40), ktp varchar(32),
        consent_at timestamptz(3), data_deletion_requested_at timestamptz(3),
        reseller_name varchar(120), reseller_id uuid, connection jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE contract_status AS ENUM ('draft', 'sent', 'signed');
      CREATE SEQUENCE contract_no_seq START WITH 1;
      CREATE TABLE contracts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        number varchar(32) NOT NULL UNIQUE
          DEFAULT ('PKS-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('contract_no_seq')::text, 4, '0')),
        customer_id uuid NOT NULL UNIQUE REFERENCES customers(id),
        customer_name varchar(120) NOT NULL,
        plan_name varchar(80) NOT NULL,
        status contract_status NOT NULL DEFAULT 'draft',
        meterai boolean NOT NULL DEFAULT false,
        signed_at timestamptz(3),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    const [plan] = await db
      .insert(plans)
      .values({ name: 'Home 20', speedMbps: 20, priceMonthly: 200_000 })
      .returning();
    if (!plan) throw new Error('plan seed failed');
    const [customer] = await db
      .insert(customers)
      .values({ fullName: 'Budi', phone: '0811', address: 'Jl. A', planId: plan.id })
      .returning();
    if (!customer) throw new Error('customer seed failed');
    customerId = customer.id;

    repo = new ContractsRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(contracts);
  });

  it('creates a numbered draft and finds it by customer', async () => {
    const created = await repo.create({ customerId, customerName: 'Budi', planName: 'Home 20' });
    expect(created.number).toMatch(/^PKS-\d{4}-\d{4}$/);
    expect(created.status).toBe('draft');
    expect(created.meterai).toBe(false);

    const found = await repo.findByCustomerId(customerId);
    expect(found?.id).toBe(created.id);
  });

  it('enforces one contract per customer', async () => {
    await repo.create({ customerId, customerName: 'Budi', planName: 'Home 20' });
    await expect(
      repo.create({ customerId, customerName: 'Budi', planName: 'Home 20' }),
    ).rejects.toThrow();
  });

  it('markSent then markSigned applies e-meterai + stamps signed_at', async () => {
    await repo.create({ customerId, customerName: 'Budi', planName: 'Home 20' });
    const sent = await repo.markSent(customerId);
    expect(sent.status).toBe('sent');

    const signed = await repo.markSigned(customerId);
    expect(signed.status).toBe('signed');
    expect(signed.meterai).toBe(true);
    expect(signed.signedAt).toBeInstanceOf(Date);
  });
});
