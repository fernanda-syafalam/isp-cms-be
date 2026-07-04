import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { CustomersRepository } from './customers.repository';

/**
 * Real Postgres integration test for CustomersRepository. Requires Docker.
 * Schema is applied by hand (mirroring migration 0003) so the test runs
 * against any commit without first regenerating drizzle SQL.
 */
describe('CustomersRepository (integration)', () => {
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
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(80) NOT NULL,
        speed_mbps integer NOT NULL,
        price_monthly integer NOT NULL,
        status plan_status NOT NULL DEFAULT 'active',
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE customer_status AS ENUM ('prospek', 'instalasi', 'aktif', 'isolir', 'berhenti');
      CREATE SEQUENCE customer_no_seq START WITH 9001;
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_no varchar(32) NOT NULL UNIQUE DEFAULT ('CUST-' || nextval('customer_no_seq')),
        full_name varchar(120) NOT NULL,
        phone varchar(20) NOT NULL,
        email varchar(255),
        user_id uuid UNIQUE,
        address varchar(255) NOT NULL,
        area_id uuid,
        area_name varchar(120),
        plan_id uuid NOT NULL REFERENCES plans(id),
        status customer_status NOT NULL DEFAULT 'prospek',
        outstanding integer NOT NULL DEFAULT 0,
        npwp varchar(40),
        ktp varchar(32),
        consent_at timestamptz(3),
        data_deletion_requested_at timestamptz(3),
        reseller_name varchar(120), reseller_id uuid,
        connection jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE INDEX customers_status_idx ON customers (status);
      CREATE INDEX customers_full_name_idx ON customers (full_name);
      CREATE INDEX customers_plan_id_idx ON customers (plan_id);
    `);

    const [plan] = await db
      .insert(plans)
      .values({ name: 'Home 20', speedMbps: 20, priceMonthly: 200_000 })
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

  it('creates customers with sequential customer_no and joins the plan name', async () => {
    const a = await repo.create({
      fullName: 'Budi',
      phone: '0811',
      address: 'Jl. A',
      planId,
    });
    const b = await repo.create({
      fullName: 'Ani',
      phone: '0812',
      address: 'Jl. B',
      planId,
    });

    expect(a.customerNo).toMatch(/^CUST-\d+$/);
    expect(Number(b.customerNo.split('-')[1])).toBe(Number(a.customerNo.split('-')[1]) + 1);
    expect(a.planName).toBe('Home 20');
    expect(a.status).toBe('prospek');
    expect(a.outstanding).toBe(0);
  });

  it('lists with status + q filters, alphabetical order and a real total', async () => {
    await repo.create({
      fullName: 'Zaki',
      phone: '0810',
      address: 'Jl. Z',
      planId,
    });
    const ani = await repo.create({
      fullName: 'Ani',
      phone: '0812',
      address: 'Jl. B',
      planId,
    });
    await repo.setStatus(ani.id, 'aktif', {});

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.items.map((c) => c.fullName)).toEqual(['Ani', 'Zaki']);

    const active = await repo.list({ status: 'aktif', limit: 50, offset: 0 });
    expect(active.total).toBe(1);
    expect(active.items[0]?.fullName).toBe('Ani');

    const search = await repo.list({ q: 'zak', limit: 50, offset: 0 });
    expect(search.total).toBe(1);
    expect(search.items[0]?.fullName).toBe('Zaki');
  });

  it('paginates with limit/offset while reporting the full total', async () => {
    for (const n of ['A', 'B', 'C']) {
      await repo.create({ fullName: n, phone: '0810', address: 'Jl.', planId });
    }
    const page = await repo.list({ limit: 2, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.items.map((c) => c.fullName)).toEqual(['A', 'B']);
  });

  it('updates profile fields and bumps updated_at', async () => {
    const created = await repo.create({
      fullName: 'Budi',
      phone: '0811',
      address: 'Jl. A',
      planId,
    });
    const updated = await repo.updateProfile(created.id, {
      phone: '0899',
      email: 'budi@isp.id',
    });
    expect(updated.phone).toBe('0899');
    expect(updated.email).toBe('budi@isp.id');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('activate clears outstanding while isolate keeps it', async () => {
    const created = await repo.create({
      fullName: 'Budi',
      phone: '0811',
      address: 'Jl. A',
      planId,
    });
    // Give the customer a debt directly (no balance API in this module).
    await db.update(customers).set({ outstanding: 150_000 }).where(eq(customers.id, created.id));

    const isolated = await repo.setStatus(created.id, 'isolir', {});
    expect(isolated.status).toBe('isolir');
    expect(isolated.outstanding).toBe(150_000);

    const activated = await repo.setStatus(created.id, 'aktif', {
      clearOutstanding: true,
    });
    expect(activated.status).toBe('aktif');
    expect(activated.outstanding).toBe(0);
  });

  it('records consent and KYC', async () => {
    const created = await repo.create({
      fullName: 'Budi',
      phone: '0811',
      address: 'Jl. A',
      planId,
    });
    const consented = await repo.recordConsent(created.id);
    expect(consented.consentAt).toBeInstanceOf(Date);

    const kyc = await repo.updateKyc(created.id, {
      ktp: '3201abc',
      npwp: null,
    });
    expect(kyc.ktp).toBe('3201abc');
    expect(kyc.npwp).toBeNull();
  });

  it('requestDataDeletion marks the row, and missing ids reject', async () => {
    const created = await repo.create({
      fullName: 'Budi',
      phone: '0811',
      address: 'Jl. A',
      planId,
    });
    await expect(repo.requestDataDeletion(created.id)).resolves.toBeUndefined();

    await expect(
      repo.requestDataDeletion('00000000-0000-0000-0000-0000000000ff'),
    ).rejects.toThrow();
    await expect(
      repo.setStatus('00000000-0000-0000-0000-0000000000ff', 'aktif', {}),
    ).rejects.toThrow();
  });

  it('resolves a customer strictly by email (portal fails closed)', async () => {
    await repo.create({
      fullName: 'Zaki',
      phone: '0813',
      email: 'zaki@example.com',
      address: 'Jl. Z',
      planId,
    });
    await repo.create({ fullName: 'Ani', phone: '0812', address: 'Jl. A', planId });

    const byEmail = await repo.findByEmail('zaki@example.com');
    expect(byEmail?.fullName).toBe('Zaki');
    expect(byEmail?.planName).toBe('Home 20');
    expect(await repo.findByEmail('nobody@example.com')).toBeNull();
  });

  it('aggregates status counts, new-since and at-risk for the dashboard', async () => {
    const a = await repo.create({ fullName: 'Aktif', phone: '08', address: 'Jl', planId });
    await repo.setStatus(a.id, 'aktif', {});
    const i = await repo.create({ fullName: 'Isolir', phone: '08', address: 'Jl', planId });
    await repo.setStatus(i.id, 'isolir', {});
    // A prospek carrying a balance — at risk despite not being isolated.
    const p = await repo.create({ fullName: 'Prospek', phone: '08', address: 'Jl', planId });
    await db.update(customers).set({ outstanding: 50_000 }).where(eq(customers.id, p.id));
    const b = await repo.create({ fullName: 'Berhenti', phone: '08', address: 'Jl', planId });
    await repo.setStatus(b.id, 'berhenti', {});

    expect(await repo.countByStatus()).toEqual({
      prospek: 1,
      instalasi: 0,
      aktif: 1,
      isolir: 1,
      berhenti: 1,
    });
    // All four were just created; a far-future cutoff sees none.
    expect(await repo.countCreatedSince(new Date('2000-01-01T00:00:00.000Z'))).toBe(4);
    expect(await repo.countCreatedSince(new Date('2999-01-01T00:00:00.000Z'))).toBe(0);
    // At risk = isolir OR outstanding > 0 -> the isolir + the prospek-with-debt.
    expect(await repo.countAtRisk()).toBe(2);
  });

  it('groups new and churned subscribers by month, honoring the since bound', async () => {
    await db.insert(customers).values([
      // Added: Feb x2 (the churned rows, created earlier), Mar x2, May x1.
      mk('Mar1', { createdAt: new Date('2026-03-10T00:00:00.000Z') }),
      mk('Mar2', { createdAt: new Date('2026-03-20T00:00:00.000Z') }),
      mk('May1', { createdAt: new Date('2026-05-05T00:00:00.000Z') }),
      // Churned: berhenti updated in Apr and Jun.
      mk('AprC', {
        status: 'berhenti',
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        updatedAt: new Date('2026-04-01T00:00:00.000Z'),
      }),
      mk('JunC', {
        status: 'berhenti',
        createdAt: new Date('2026-02-02T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
      // Before the window — excluded by the since bound.
      mk('Old', { createdAt: new Date('2025-12-15T00:00:00.000Z') }),
    ]);

    const since = new Date('2026-01-01T00:00:00.000Z');
    const byMonth = (rows: Array<{ month: string; count: number }>) =>
      [...rows].sort((x, y) => x.month.localeCompare(y.month));

    expect(byMonth(await repo.countCreatedByMonth(since))).toEqual([
      { month: '2026-02', count: 2 },
      { month: '2026-03', count: 2 },
      { month: '2026-05', count: 1 },
    ]);
    expect(byMonth(await repo.countChurnedByMonth(since))).toEqual([
      { month: '2026-04', count: 1 },
      { month: '2026-06', count: 1 },
    ]);
  });

  // Insert helper for the month-grouping aggregates (explicit timestamps).
  function mk(
    fullName: string,
    over: Partial<typeof customers.$inferInsert> = {},
  ): typeof customers.$inferInsert {
    return { fullName, phone: '08', address: 'Jl', planId, ...over };
  }
});
