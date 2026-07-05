import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { invoices } from '../../infrastructure/database/schema/invoices.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { InvoicesRepository } from '../invoices/invoices.repository';

/**
 * Real Postgres integration test for the accounting seam
 * (InvoicesRepository.findPaidInPeriod). Requires Docker. No accounting
 * table — the journal is computed in the service from this query.
 */
describe('Accounting seam — InvoicesRepository.findPaidInPeriod (integration)', () => {
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
      CREATE TYPE customer_hold_reason AS ENUM ('overdue', 'voluntary');
      CREATE SEQUENCE customer_no_seq START WITH 9001;
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_no varchar(32) NOT NULL UNIQUE DEFAULT ('CUST-' || nextval('customer_no_seq')),
        full_name varchar(120) NOT NULL, phone varchar(20) NOT NULL, email varchar(255), user_id uuid UNIQUE,
        address varchar(255) NOT NULL, area_id uuid, area_name varchar(120),
        plan_id uuid NOT NULL REFERENCES plans(id), status customer_status NOT NULL DEFAULT 'prospek', hold_reason customer_hold_reason,
        outstanding integer NOT NULL DEFAULT 0, npwp varchar(40), ktp varchar(32),
        consent_at timestamptz(3), data_deletion_requested_at timestamptz(3),
        reseller_name varchar(120), reseller_id uuid, connection jsonb,
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
      .values({ fullName: 'Budi', phone: '0811', address: 'Jl. A', planId: plan.id })
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

  it('returns only paid invoices settled within the period', async () => {
    await db.insert(invoices).values([
      {
        customerId,
        customerName: 'Budi',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        amount: 200_000,
        dueDate: '2026-05-10',
        status: 'paid',
        paidAt: new Date('2026-05-03T10:30:00.000Z'),
      },
      {
        customerId,
        customerName: 'Budi',
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        amount: 200_000,
        dueDate: '2026-06-10',
        status: 'paid',
        paidAt: new Date('2026-06-04T09:00:00.000Z'),
      },
      {
        customerId,
        customerName: 'Budi',
        periodStart: '2026-07-01',
        periodEnd: '2026-07-31',
        amount: 200_000,
        dueDate: '2026-07-10',
        status: 'pending',
      },
    ]);

    const may = await repo.findPaidInPeriod('2026-05');
    expect(may).toHaveLength(1);
    expect(may[0]?.periodStart).toBe('2026-05-01');

    const june = await repo.findPaidInPeriod('2026-06');
    expect(june).toHaveLength(1);

    const july = await repo.findPaidInPeriod('2026-07'); // pending, not settled
    expect(july).toHaveLength(0);
  });
});
