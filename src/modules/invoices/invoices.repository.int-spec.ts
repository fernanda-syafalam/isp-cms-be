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

  // ---------------------------------------------------------------------------
  // list — full-set summary aggregate (the invariant)
  // ---------------------------------------------------------------------------

  describe('list — summary aggregate', () => {
    it('summary.total counts every invoice regardless of status filter', async () => {
      await repo.create(newInvoice({ periodStart: '2026-06-01', status: 'pending' }));
      await repo.create(
        newInvoice({ periodStart: '2026-07-01', status: 'overdue', lateFee: 25_000 }),
      );
      await repo.create(newInvoice({ periodStart: '2026-08-01', status: 'paid' }));

      // Filtered view: only overdue
      const result = await repo.list({ status: 'overdue', limit: 50, offset: 0 });
      expect(result.total).toBe(1); // filtered total
      // Full-set summary — must still count 3 invoices
      expect(result.summary.total).toBe(3);
    });

    it('summary.outstanding sums grand totals for pending + overdue', async () => {
      // pending: 200k amount + 0 fee + 22k tax = 222k
      await repo.create(newInvoice({ periodStart: '2026-06-01', status: 'pending' }));
      // overdue: 200k amount + 25k fee + 22k tax = 247k
      await repo.create(
        newInvoice({ periodStart: '2026-07-01', status: 'overdue', lateFee: 25_000 }),
      );
      // paid: excluded
      await repo.create(newInvoice({ periodStart: '2026-08-01', status: 'paid' }));

      const result = await repo.list({ status: 'paid', limit: 50, offset: 0 });
      // Even though we filtered for paid, outstanding covers both pending+overdue
      expect(result.summary.outstanding).toBe(222_000 + 247_000);
      expect(result.summary.overdue).toBe(247_000);
      expect(result.summary.unpaidCount).toBe(2);
    });

    it('summary does not change when q filter matches only some invoices', async () => {
      await repo.create(
        newInvoice({ periodStart: '2026-06-01', status: 'pending', customerName: 'Alpha User' }),
      );
      await repo.create(
        newInvoice({
          periodStart: '2026-07-01',
          status: 'overdue',
          lateFee: 25_000,
          customerName: 'Beta User',
        }),
      );
      await repo.create(
        newInvoice({ periodStart: '2026-08-01', status: 'paid', customerName: 'Alpha Paid' }),
      );

      // Filter by q=Alpha: matches 2 invoices (pending + paid)
      const filtered = await repo.list({ q: 'Alpha', limit: 50, offset: 0 });
      expect(filtered.total).toBe(2); // filtered total

      // Full-set without q
      const all = await repo.list({ limit: 50, offset: 0 });

      // Summary must be identical — q does not affect it
      expect(filtered.summary.total).toBe(all.summary.total);
      expect(filtered.summary.outstanding).toBe(all.summary.outstanding);
      expect(filtered.summary.overdue).toBe(all.summary.overdue);
      expect(filtered.summary.unpaidCount).toBe(all.summary.unpaidCount);
    });

    it('summary is zero when no invoices exist', async () => {
      const result = await repo.list({ limit: 50, offset: 0 });
      expect(result.summary).toEqual({ total: 0, outstanding: 0, overdue: 0, unpaidCount: 0 });
    });
  });

  // ---------------------------------------------------------------------------
  // list — search (q)
  // ---------------------------------------------------------------------------

  describe('list — search (q)', () => {
    it('matches invoiceNo substring case-insensitively', async () => {
      // invoiceNo is generated by DB sequence; we cannot control it exactly,
      // but we can search by a fragment of the auto-generated value.
      const inv1 = await repo.create(newInvoice({ periodStart: '2026-06-01' }));
      await repo.create(newInvoice({ periodStart: '2026-07-01' }));

      // The invoiceNo looks like "INV-2026-NNN"; search for the fragment
      const fragment = inv1.invoiceNo.slice(-3); // last 3 digits
      const result = await repo.list({ q: fragment, limit: 50, offset: 0 });
      // Should match exactly 1 (the one containing that fragment)
      expect(result.items.some((i) => i.id === inv1.id)).toBe(true);
    });

    it('matches customerName substring case-insensitively', async () => {
      await repo.create(newInvoice({ periodStart: '2026-06-01', customerName: 'Budi Santoso' }));
      await repo.create(newInvoice({ periodStart: '2026-07-01', customerName: 'Ani Wijaya' }));
      await repo.create(newInvoice({ periodStart: '2026-08-01', customerName: 'Budi Kurniawan' }));

      const result = await repo.list({ q: 'budi', limit: 50, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.items.every((i) => i.customerName.toLowerCase().includes('budi'))).toBe(true);
    });

    it('total reflects the q filter, not the full table count', async () => {
      await repo.create(
        newInvoice({ periodStart: '2026-06-01', customerName: 'Matching Customer' }),
      );
      await repo.create(
        newInvoice({ periodStart: '2026-07-01', customerName: 'Matching Customer' }),
      );
      await repo.create(newInvoice({ periodStart: '2026-08-01', customerName: 'Other Customer' }));

      const result = await repo.list({ q: 'Matching', limit: 50, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // list — sort
  // ---------------------------------------------------------------------------

  describe('list — sort', () => {
    it('sorts by amount ascending', async () => {
      await repo.create(
        newInvoice({ periodStart: '2026-06-01', amount: 300_000, dueDate: '2026-06-10' }),
      );
      await repo.create(
        newInvoice({ periodStart: '2026-07-01', amount: 100_000, dueDate: '2026-07-10' }),
      );
      await repo.create(
        newInvoice({ periodStart: '2026-08-01', amount: 200_000, dueDate: '2026-08-10' }),
      );

      const result = await repo.list({ sort: 'amount', order: 'asc', limit: 50, offset: 0 });
      expect(result.items.map((i) => i.amount)).toEqual([100_000, 200_000, 300_000]);
    });

    it('sorts by amount descending', async () => {
      await repo.create(
        newInvoice({ periodStart: '2026-06-01', amount: 300_000, dueDate: '2026-06-10' }),
      );
      await repo.create(
        newInvoice({ periodStart: '2026-07-01', amount: 100_000, dueDate: '2026-07-10' }),
      );
      await repo.create(
        newInvoice({ periodStart: '2026-08-01', amount: 200_000, dueDate: '2026-08-10' }),
      );

      const result = await repo.list({ sort: 'amount', order: 'desc', limit: 50, offset: 0 });
      expect(result.items.map((i) => i.amount)).toEqual([300_000, 200_000, 100_000]);
    });

    it('sorts by dueDate ascending', async () => {
      await repo.create(newInvoice({ periodStart: '2026-06-01', dueDate: '2026-06-20' }));
      await repo.create(newInvoice({ periodStart: '2026-07-01', dueDate: '2026-07-05' }));
      await repo.create(newInvoice({ periodStart: '2026-08-01', dueDate: '2026-08-10' }));

      const result = await repo.list({ sort: 'dueDate', order: 'asc', limit: 50, offset: 0 });
      expect(result.items.map((i) => i.dueDate)).toEqual([
        '2026-06-20',
        '2026-07-05',
        '2026-08-10',
      ]);
    });

    it('falls back to dueDate desc when sort key is unknown', async () => {
      await repo.create(newInvoice({ periodStart: '2026-06-01', dueDate: '2026-06-10' }));
      await repo.create(newInvoice({ periodStart: '2026-07-01', dueDate: '2026-07-10' }));
      await repo.create(newInvoice({ periodStart: '2026-08-01', dueDate: '2026-08-10' }));

      // Unknown sort key → fallback: dueDate desc → newest due date first
      const result = await repo.list({ sort: 'notAColumn', order: 'asc', limit: 50, offset: 0 });
      expect(result.items.map((i) => i.dueDate)).toEqual([
        '2026-08-10',
        '2026-07-10',
        '2026-06-10',
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // list — paging keeps total + summary invariant
  // ---------------------------------------------------------------------------

  it('limit/offset paging: total and summary are not affected by window size', async () => {
    for (let i = 1; i <= 5; i += 1) {
      const mm = String(i + 5).padStart(2, '0');
      await repo.create(newInvoice({ periodStart: `2026-${mm}-01`, status: 'pending' }));
    }

    const page1 = await repo.list({ limit: 2, offset: 0 });
    const page2 = await repo.list({ limit: 2, offset: 2 });

    expect(page1.total).toBe(5); // full filtered count
    expect(page2.total).toBe(5);
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);

    // Summary must be identical between pages — it covers all rows.
    expect(page1.summary.total).toBe(5);
    expect(page2.summary.total).toBe(5);
    expect(page1.summary).toEqual(page2.summary);
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

  describe('listPayments — search (q)', () => {
    it('matches by invoiceNo substring case-insensitively', async () => {
      const inv1 = await repo.create(newInvoice({ periodStart: '2026-06-01' }));
      const inv2 = await repo.create(newInvoice({ periodStart: '2026-07-01' }));
      await repo.createPayment({
        invoiceId: inv1.id,
        invoiceNo: 'INV-2026-ALPHA',
        customerId,
        customerName: 'Budi',
        amount: 100_000,
        method: 'transfer',
      });
      await repo.createPayment({
        invoiceId: inv2.id,
        invoiceNo: 'INV-2026-BETA',
        customerId,
        customerName: 'Budi',
        amount: 200_000,
        method: 'cash',
      });

      const result = await repo.listPayments({ q: 'alpha', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.invoiceNo).toBe('INV-2026-ALPHA');
    });

    it('matches by customerName substring case-insensitively', async () => {
      const inv1 = await repo.create(newInvoice({ periodStart: '2026-06-01' }));
      const inv2 = await repo.create(newInvoice({ periodStart: '2026-07-01' }));
      await repo.createPayment({
        invoiceId: inv1.id,
        invoiceNo: inv1.invoiceNo,
        customerId,
        customerName: 'Budi Santoso',
        amount: 100_000,
        method: 'transfer',
      });
      await repo.createPayment({
        invoiceId: inv2.id,
        invoiceNo: inv2.invoiceNo,
        customerId,
        customerName: 'Ani Wijaya',
        amount: 200_000,
        method: 'cash',
      });

      const result = await repo.listPayments({ q: 'santoso', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.customerName).toBe('Budi Santoso');
    });

    it('total reflects the q filter, not the full table count', async () => {
      const inv1 = await repo.create(newInvoice({ periodStart: '2026-06-01' }));
      const inv2 = await repo.create(newInvoice({ periodStart: '2026-07-01' }));
      const inv3 = await repo.create(newInvoice({ periodStart: '2026-08-01' }));
      await repo.createPayment({
        invoiceId: inv1.id,
        invoiceNo: inv1.invoiceNo,
        customerId,
        customerName: 'Match Name',
        amount: 100_000,
        method: 'transfer',
      });
      await repo.createPayment({
        invoiceId: inv2.id,
        invoiceNo: inv2.invoiceNo,
        customerId,
        customerName: 'Match Name',
        amount: 200_000,
        method: 'cash',
      });
      await repo.createPayment({
        invoiceId: inv3.id,
        invoiceNo: inv3.invoiceNo,
        customerId,
        customerName: 'Other Name',
        amount: 300_000,
        method: 'qris',
      });

      const result = await repo.listPayments({ q: 'Match', limit: 50, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
    });
  });

  describe('listPayments — sort', () => {
    // Helper to seed a payment with explicit paidAt so sort order is deterministic.
    async function seedPayment(
      inv: { id: string; invoiceNo: string },
      overrides: {
        customerName: string;
        amount: number;
        method: typeof payments.$inferInsert.method;
        paidAt: string;
      },
    ) {
      await db.insert(payments).values({
        invoiceId: inv.id,
        invoiceNo: inv.invoiceNo,
        customerId,
        customerName: overrides.customerName,
        amount: overrides.amount,
        method: overrides.method,
        paidAt: new Date(overrides.paidAt),
      });
    }

    it('sorts by amount ascending', async () => {
      const inv1 = await repo.create(newInvoice({ periodStart: '2026-06-01' }));
      const inv2 = await repo.create(newInvoice({ periodStart: '2026-07-01' }));
      const inv3 = await repo.create(newInvoice({ periodStart: '2026-08-01' }));
      await seedPayment(inv1, {
        customerName: 'A',
        amount: 300_000,
        method: 'cash',
        paidAt: '2026-06-01T00:00:00.000Z',
      });
      await seedPayment(inv2, {
        customerName: 'B',
        amount: 100_000,
        method: 'cash',
        paidAt: '2026-06-02T00:00:00.000Z',
      });
      await seedPayment(inv3, {
        customerName: 'C',
        amount: 200_000,
        method: 'cash',
        paidAt: '2026-06-03T00:00:00.000Z',
      });

      const asc = await repo.listPayments({ sort: 'amount', order: 'asc', limit: 50, offset: 0 });
      expect(asc.items.map((p) => p.amount)).toEqual([100_000, 200_000, 300_000]);
    });

    it('sorts by amount descending', async () => {
      const inv1 = await repo.create(newInvoice({ periodStart: '2026-06-01' }));
      const inv2 = await repo.create(newInvoice({ periodStart: '2026-07-01' }));
      const inv3 = await repo.create(newInvoice({ periodStart: '2026-08-01' }));
      await seedPayment(inv1, {
        customerName: 'A',
        amount: 300_000,
        method: 'cash',
        paidAt: '2026-06-01T00:00:00.000Z',
      });
      await seedPayment(inv2, {
        customerName: 'B',
        amount: 100_000,
        method: 'cash',
        paidAt: '2026-06-02T00:00:00.000Z',
      });
      await seedPayment(inv3, {
        customerName: 'C',
        amount: 200_000,
        method: 'cash',
        paidAt: '2026-06-03T00:00:00.000Z',
      });

      const desc = await repo.listPayments({ sort: 'amount', order: 'desc', limit: 50, offset: 0 });
      expect(desc.items.map((p) => p.amount)).toEqual([300_000, 200_000, 100_000]);
    });

    it('sorts by paidAt ascending', async () => {
      const inv1 = await repo.create(newInvoice({ periodStart: '2026-06-01' }));
      const inv2 = await repo.create(newInvoice({ periodStart: '2026-07-01' }));
      const inv3 = await repo.create(newInvoice({ periodStart: '2026-08-01' }));
      await seedPayment(inv1, {
        customerName: 'A',
        amount: 100_000,
        method: 'cash',
        paidAt: '2026-06-03T00:00:00.000Z',
      });
      await seedPayment(inv2, {
        customerName: 'B',
        amount: 200_000,
        method: 'cash',
        paidAt: '2026-06-01T00:00:00.000Z',
      });
      await seedPayment(inv3, {
        customerName: 'C',
        amount: 300_000,
        method: 'cash',
        paidAt: '2026-06-02T00:00:00.000Z',
      });

      const result = await repo.listPayments({
        sort: 'paidAt',
        order: 'asc',
        limit: 50,
        offset: 0,
      });
      expect(result.items.map((p) => p.amount)).toEqual([200_000, 300_000, 100_000]);
    });

    it('falls back to paidAt desc when sort key is unknown', async () => {
      const inv1 = await repo.create(newInvoice({ periodStart: '2026-06-01' }));
      const inv2 = await repo.create(newInvoice({ periodStart: '2026-07-01' }));
      const inv3 = await repo.create(newInvoice({ periodStart: '2026-08-01' }));
      await seedPayment(inv1, {
        customerName: 'A',
        amount: 100_000,
        method: 'cash',
        paidAt: '2026-06-01T00:00:00.000Z',
      });
      await seedPayment(inv2, {
        customerName: 'B',
        amount: 200_000,
        method: 'cash',
        paidAt: '2026-06-02T00:00:00.000Z',
      });
      await seedPayment(inv3, {
        customerName: 'C',
        amount: 300_000,
        method: 'cash',
        paidAt: '2026-06-03T00:00:00.000Z',
      });

      // Unknown key → default paidAt desc → newest first (300_000 at 06-03)
      const result = await repo.listPayments({
        sort: 'notAColumn',
        order: 'asc',
        limit: 50,
        offset: 0,
      });
      expect(result.items.map((p) => p.amount)).toEqual([300_000, 200_000, 100_000]);
    });
  });

  it('scopes invoices and payments to one customer for the portal', async () => {
    const jun = await repo.create(newInvoice({ periodStart: '2026-06-01' }));
    await repo.create(newInvoice({ periodStart: '2026-07-01' }));
    await repo.createPayment({
      invoiceId: jun.id,
      invoiceNo: jun.invoiceNo,
      customerId,
      customerName: 'Budi',
      amount: 222_000,
      method: 'qris',
    });

    const invoicesForCustomer = await repo.listByCustomer(customerId);
    expect(invoicesForCustomer).toHaveLength(2);

    const paymentsForCustomer = await repo.listPaymentsByCustomer(customerId);
    expect(paymentsForCustomer).toHaveLength(1);
    expect(paymentsForCustomer[0]?.method).toBe('qris');

    const other = '00000000-0000-0000-0000-0000000000ff';
    expect(await repo.listByCustomer(other)).toHaveLength(0);
    expect(await repo.listPaymentsByCustomer(other)).toHaveLength(0);
  });

  it('lists every unpaid invoice oldest-due first for the receivables rollup', async () => {
    await repo.create(
      newInvoice({ periodStart: '2026-05-01', status: 'overdue', dueDate: '2026-05-10' }),
    );
    await repo.create(
      newInvoice({ periodStart: '2026-06-01', status: 'pending', dueDate: '2026-06-10' }),
    );
    await repo.create(
      newInvoice({ periodStart: '2026-07-01', status: 'paid', dueDate: '2026-07-10' }),
    );
    await repo.create(
      newInvoice({ periodStart: '2026-08-01', status: 'draft', dueDate: '2026-08-10' }),
    );

    const unpaid = await repo.listUnpaid();
    // Only pending + overdue, sorted by due date ascending.
    expect(unpaid.map((i) => i.status)).toEqual(['overdue', 'pending']);
    expect(unpaid.map((i) => i.dueDate)).toEqual(['2026-05-10', '2026-06-10']);
  });

  it('sums settled cash per month from payments, honoring the since cutoff', async () => {
    const inv = await repo.create(newInvoice());
    await db.insert(payments).values([
      mkPayment(inv, 100_000, 'transfer', '2026-04-15T00:00:00.000Z'),
      mkPayment(inv, 50_000, 'qris', '2026-04-20T00:00:00.000Z'),
      mkPayment(inv, 200_000, 'va', '2026-06-01T00:00:00.000Z'),
      // Before the cutoff — excluded.
      mkPayment(inv, 999_000, 'cash', '2025-12-01T00:00:00.000Z'),
    ]);

    const since = new Date('2026-01-01T00:00:00.000Z');
    const byMonth = (await repo.revenueByMonth(since)).sort((a, b) =>
      a.month.localeCompare(b.month),
    );
    expect(byMonth).toEqual([
      { month: '2026-04', revenue: 150_000 },
      { month: '2026-06', revenue: 200_000 },
    ]);
  });

  // Payment-ledger insert helper with an explicit paid_at (month grouping).
  function mkPayment(
    inv: { id: string; invoiceNo: string },
    amount: number,
    method: typeof payments.$inferInsert.method,
    paidAt: string,
  ): typeof payments.$inferInsert {
    return {
      invoiceId: inv.id,
      invoiceNo: inv.invoiceNo,
      customerId,
      customerName: 'Budi',
      amount,
      method,
      paidAt: new Date(paidAt),
    };
  }
});
