import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { workOrders } from '../../infrastructure/database/schema/work-orders.schema';
import { WorkOrdersRepository } from './work-orders.repository';

/**
 * Real Postgres integration test for WorkOrdersRepository. Requires Docker.
 * Schema applied by hand (mirroring migrations 0002-0006).
 */
describe('WorkOrdersRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: WorkOrdersRepository;
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
      CREATE SEQUENCE customer_no_seq START WITH 9001;
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_no varchar(32) NOT NULL UNIQUE DEFAULT ('CUST-' || nextval('customer_no_seq')),
        full_name varchar(120) NOT NULL, phone varchar(20) NOT NULL, email varchar(255),
        address varchar(255) NOT NULL, area_id uuid, area_name varchar(120),
        plan_id uuid NOT NULL REFERENCES plans(id),
        status customer_status NOT NULL DEFAULT 'prospek',
        outstanding integer NOT NULL DEFAULT 0, npwp varchar(40), ktp varchar(32),
        consent_at timestamptz(3), data_deletion_requested_at timestamptz(3),
        reseller_name varchar(120), connection jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE work_order_type AS ENUM ('install', 'repair', 'dismantle');
      CREATE TYPE work_order_status AS ENUM ('scheduled', 'in_progress', 'done', 'cancelled');
      CREATE SEQUENCE work_order_code_seq START WITH 9001;
      CREATE TABLE work_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(32) NOT NULL UNIQUE DEFAULT ('WO-' || nextval('work_order_code_seq')),
        type work_order_type NOT NULL,
        customer_id uuid REFERENCES customers(id),
        customer_name varchar(120) NOT NULL,
        technician varchar(120),
        scheduled_at timestamptz(3) NOT NULL,
        status work_order_status NOT NULL DEFAULT 'scheduled',
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
      .values({
        fullName: 'Budi',
        phone: '0811',
        address: 'Jl. A',
        planId: plan.id,
      })
      .returning();
    if (!customer) throw new Error('customer seed failed');
    customerId = customer.id;

    repo = new WorkOrdersRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(workOrders);
  });

  const newWo = (over: Partial<typeof workOrders.$inferInsert> = {}) => ({
    type: 'install' as const,
    customerId,
    customerName: 'Budi',
    technician: 'Teknisi Budi',
    scheduledAt: new Date('2026-06-16T00:00:00.000Z'),
    ...over,
  });

  it('creates work orders with a sequential WO code', async () => {
    const a = await repo.create(newWo());
    const b = await repo.create(newWo({ type: 'repair' }));
    expect(a.code).toMatch(/^WO-\d+$/);
    expect(Number(b.code.split('-')[1])).toBe(Number(a.code.split('-')[1]) + 1);
    expect(a.status).toBe('scheduled');
  });

  it('lists by status with a real total and limit/offset', async () => {
    await repo.create(newWo());
    await repo.create(newWo({ status: 'done' }));
    await repo.create(newWo({ status: 'done' }));

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);

    const done = await repo.list({ status: 'done', limit: 50, offset: 0 });
    expect(done.total).toBe(2);

    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('markDone flips status and rejects a missing order', async () => {
    const created = await repo.create(newWo());
    const done = await repo.markDone(created.id);
    expect(done.status).toBe('done');
    await expect(repo.markDone('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });
});
