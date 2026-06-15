import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { invoices } from '../../infrastructure/database/schema/invoices.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { InvoicesRepository } from './invoices.repository';

/**
 * Real Postgres integration test for the billing-automation repo methods
 * (date-based overdue logic). Requires Docker.
 */
describe('InvoicesRepository billing-automation (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: InvoicesRepository;
  let customerId: string;

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
        full_name varchar(120) NOT NULL, phone varchar(20) NOT NULL, email varchar(255),
        address varchar(255) NOT NULL, area_id uuid, area_name varchar(120),
        plan_id uuid NOT NULL REFERENCES plans(id), status customer_status NOT NULL DEFAULT 'prospek',
        outstanding integer NOT NULL DEFAULT 0, npwp varchar(40), ktp varchar(32),
        consent_at timestamptz(3), data_deletion_requested_at timestamptz(3),
        reseller_name varchar(120), connection jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE invoice_status AS ENUM ('draft', 'pending', 'overdue', 'paid');
      CREATE TYPE payment_method AS ENUM ('qris', 'va', 'ewallet', 'transfer', 'cash');
      CREATE SEQUENCE invoice_no_seq START WITH 100;
      CREATE TABLE invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_no varchar(32) NOT NULL UNIQUE
          DEFAULT ('INV-' || to_char(now(), 'YYYY') || '-' || nextval('invoice_no_seq')),
        customer_id uuid NOT NULL REFERENCES customers(id), customer_name varchar(120) NOT NULL,
        period_start date NOT NULL, period_end date NOT NULL,
        amount integer NOT NULL, late_fee integer NOT NULL DEFAULT 0,
        tax_amount integer NOT NULL DEFAULT 0, tax_invoice_no varchar(40),
        status invoice_status NOT NULL DEFAULT 'pending', due_date date NOT NULL,
        paid_at timestamptz(3), last_reminded_at timestamptz(3),
        created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX invoices_customer_period_idx ON invoices (customer_id, period_start);
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
        status: 'aktif',
      })
      .returning();
    if (!customer) throw new Error('customer seed failed');
    customerId = customer.id;

    repo = new InvoicesRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(invoices);
  });

  it('markOverduePastDue flips only past-due pending invoices + applies fee', async () => {
    await db.insert(invoices).values([
      {
        customerId,
        customerName: 'Budi',
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        amount: 200_000,
        dueDate: '2020-01-10',
        status: 'pending',
      },
      {
        customerId,
        customerName: 'Budi',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        amount: 200_000,
        dueDate: '2999-01-10',
        status: 'pending',
      },
    ]);

    const flipped = await repo.markOverduePastDue(25_000);
    expect(flipped).toBe(1);
    expect(await repo.countOverdueAll()).toBe(1);

    const ids = await repo.customerIdsWithOverdue();
    expect(ids).toEqual([customerId]);

    // the overdue one now carries the late fee + total includes it
    expect(await repo.sumUnpaidByCustomer(customerId)).toBe(200_000 + 25_000 + 200_000);
  });

  it('markRemindedOverdue stamps last_reminded_at on overdue invoices', async () => {
    await db.insert(invoices).values({
      customerId,
      customerName: 'Budi',
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      amount: 200_000,
      dueDate: '2020-01-10',
      status: 'overdue',
    });
    const reminded = await repo.markRemindedOverdue();
    expect(reminded).toBe(1);
    const { items } = await repo.list({ status: 'overdue', limit: 10, offset: 0 });
    expect(items[0]?.lastRemindedAt).toBeInstanceOf(Date);
  });
});
