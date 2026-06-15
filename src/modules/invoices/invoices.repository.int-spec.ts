import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { invoices, payments } from '../../infrastructure/database/schema/invoices.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { InvoicesRepository } from './invoices.repository';

/**
 * Real Postgres integration test for InvoicesRepository. Requires Docker.
 * Schema is applied by hand (mirroring migrations 0002-0004).
 */
describe('InvoicesRepository (integration)', () => {
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
      CREATE TYPE invoice_status AS ENUM ('draft', 'pending', 'overdue', 'paid');
      CREATE TYPE payment_method AS ENUM ('qris', 'va', 'ewallet', 'transfer', 'cash');
      CREATE SEQUENCE invoice_no_seq START WITH 100;
      CREATE TABLE invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_no varchar(32) NOT NULL UNIQUE
          DEFAULT ('INV-' || to_char(now(), 'YYYY') || '-' || nextval('invoice_no_seq')),
        customer_id uuid NOT NULL REFERENCES customers(id),
        customer_name varchar(120) NOT NULL,
        period_start date NOT NULL, period_end date NOT NULL,
        amount integer NOT NULL, late_fee integer NOT NULL DEFAULT 0,
        tax_amount integer NOT NULL DEFAULT 0, tax_invoice_no varchar(40),
        status invoice_status NOT NULL DEFAULT 'pending', due_date date NOT NULL,
        paid_at timestamptz(3), last_reminded_at timestamptz(3),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX invoices_customer_period_idx ON invoices (customer_id, period_start);
      CREATE TABLE payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_id uuid NOT NULL REFERENCES invoices(id),
        invoice_no varchar(32) NOT NULL, customer_id uuid NOT NULL,
        customer_name varchar(120) NOT NULL, amount integer NOT NULL,
        method payment_method NOT NULL,
        paid_at timestamptz(3) NOT NULL DEFAULT now(),
        created_at timestamptz(3) NOT NULL DEFAULT now()
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
    await db.delete(payments);
    await db.delete(invoices);
  });

  const newInvoice = (over: Partial<typeof invoices.$inferInsert> = {}) => ({
    customerId,
    customerName: 'Budi',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    amount: 200_000,
    taxAmount: 22_000,
    dueDate: '2026-06-10',
    ...over,
  });

  it('creates invoices with a sequential INV number and detects the period', async () => {
    const a = await repo.create(newInvoice());
    const b = await repo.create(newInvoice({ periodStart: '2026-07-01', periodEnd: '2026-07-31' }));

    expect(a.invoiceNo).toMatch(/^INV-\d{4}-\d+$/);
    expect(Number(b.invoiceNo.split('-')[2])).toBe(Number(a.invoiceNo.split('-')[2]) + 1);
    expect(await repo.existsForPeriod(customerId, '2026-06-01')).toBe(true);
    expect(await repo.existsForPeriod(customerId, '2026-09-01')).toBe(false);
  });

  it('enforces one invoice per customer per period', async () => {
    await repo.create(newInvoice());
    await expect(repo.create(newInvoice())).rejects.toThrow();
  });

  it('lists by status with a real total and limit/offset', async () => {
    await repo.create(newInvoice());
    await repo.create(newInvoice({ periodStart: '2026-07-01', status: 'overdue' }));
    await repo.create(newInvoice({ periodStart: '2026-08-01', status: 'paid' }));

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);

    const overdue = await repo.list({
      status: 'overdue',
      limit: 50,
      offset: 0,
    });
    expect(overdue.total).toBe(1);
    expect(overdue.items[0]?.status).toBe('overdue');

    const page = await repo.list({ limit: 2, offset: 0 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  it('markPaid flips status and stamps paid_at', async () => {
    const created = await repo.create(newInvoice());
    const paid = await repo.markPaid(created.id);
    expect(paid.status).toBe('paid');
    expect(paid.paidAt).toBeInstanceOf(Date);
  });

  it('sums unpaid totals and counts overdue per customer', async () => {
    await repo.create(newInvoice({ periodStart: '2026-06-01', status: 'pending' })); // 222000
    await repo.create(
      newInvoice({
        periodStart: '2026-07-01',
        status: 'overdue',
        lateFee: 25_000,
      }),
    ); // 247000
    await repo.create(newInvoice({ periodStart: '2026-08-01', status: 'paid' })); // excluded

    expect(await repo.sumUnpaidByCustomer(customerId)).toBe(222_000 + 247_000);
    expect(await repo.countOverdueByCustomer(customerId)).toBe(1);
  });

  it('records payments into the ledger', async () => {
    const inv = await repo.create(newInvoice());
    await repo.createPayment({
      invoiceId: inv.id,
      invoiceNo: inv.invoiceNo,
      customerId,
      customerName: 'Budi',
      amount: 222_000,
      method: 'transfer',
    });
    const ledger = await repo.listPayments({ limit: 50, offset: 0 });
    expect(ledger.total).toBe(1);
    expect(ledger.items[0]?.amount).toBe(222_000);
    expect(ledger.items[0]?.method).toBe('transfer');
  });
});
