import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { invoices, payments } from '../../infrastructure/database/schema/invoices.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { resellerLedger, resellers } from '../../infrastructure/database/schema/resellers.schema';
import { vouchers } from '../../infrastructure/database/schema/vouchers.schema';
import { VouchersRepository } from './vouchers.repository';

/**
 * Real Postgres integration test for VouchersRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0009, 0043). `settle()`
 * (P3.D.3) writes across payments/customers/invoices/resellers/
 * reseller_ledger in one transaction (allocating to unpaid invoices exactly
 * like a real payment, never a direct `customers.outstanding` decrement —
 * see `allocateToInvoices`'s doc), so this suite's DDL mirrors those tables
 * too — minimal columns, just enough for the FKs plus the fields settle()
 * reads/writes.
 */
describe('VouchersRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: VouchersRepository;
  let planId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE reseller_status AS ENUM ('active', 'inactive');
      CREATE TYPE reseller_ledger_type AS ENUM ('topup', 'commission', 'deduction', 'withdrawal');
      CREATE TABLE resellers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(120) NOT NULL, area varchar(120) NOT NULL,
        balance integer NOT NULL DEFAULT 0, commission_pct real NOT NULL DEFAULT 0,
        status reseller_status NOT NULL DEFAULT 'active',
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TABLE reseller_ledger (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        reseller_id uuid NOT NULL REFERENCES resellers(id),
        type reseller_ledger_type NOT NULL,
        amount integer NOT NULL,
        note varchar(200) NOT NULL DEFAULT '',
        balance_after integer NOT NULL,
        ref varchar(64),
        at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX reseller_ledger_reseller_type_ref_idx
        ON reseller_ledger (reseller_id, type, ref) WHERE ref IS NOT NULL;

      CREATE TYPE voucher_status AS ENUM ('unused', 'used', 'expired');
      CREATE TABLE vouchers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(32) NOT NULL UNIQUE,
        batch_id varchar(32) NOT NULL,
        profile varchar(80) NOT NULL,
        price_idr integer NOT NULL,
        duration_days integer NOT NULL,
        status voucher_status NOT NULL DEFAULT 'unused',
        used_at timestamptz(3),
        used_by varchar(120),
        redeemed_customer_id uuid,
        reseller_id uuid REFERENCES resellers(id),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE INDEX vouchers_reseller_id_idx ON vouchers (reseller_id);

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
        lat double precision, lng double precision, odp_id varchar(60), billing_anchor_day smallint,
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

      -- Full invoices table — allocateToInvoices (P3.D.3) reads/writes
      -- amount/lateFee/taxAmount/discountAmount/paidAmount/status/dueDate for
      -- real, so (unlike the payments.invoice_id stub pattern elsewhere) this
      -- suite needs the whole table, not a minimal FK-target stub.
      CREATE TYPE invoice_status AS ENUM ('draft', 'pending', 'partial', 'overdue', 'paid');
      CREATE TYPE invoice_type AS ENUM ('regular', 'adjustment');
      CREATE TABLE invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_no varchar(32) NOT NULL UNIQUE,
        customer_id uuid NOT NULL REFERENCES customers(id),
        customer_name varchar(120) NOT NULL,
        type invoice_type NOT NULL DEFAULT 'regular', note varchar(200),
        period_start date NOT NULL, period_end date NOT NULL,
        amount integer NOT NULL, late_fee integer NOT NULL DEFAULT 0,
        tax_amount integer NOT NULL DEFAULT 0, discount_amount integer NOT NULL DEFAULT 0,
        paid_amount integer NOT NULL DEFAULT 0, tax_invoice_no varchar(40),
        status invoice_status NOT NULL DEFAULT 'pending', due_date date NOT NULL,
        paid_at timestamptz(3), last_reminded_at timestamptz(3),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE payment_method AS ENUM ('qris', 'va', 'ewallet', 'transfer', 'cash');
      CREATE TYPE payment_source AS ENUM ('invoice', 'voucher');
      CREATE TABLE payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_id uuid REFERENCES invoices(id),
        invoice_no varchar(32), customer_id uuid, customer_name varchar(120),
        amount integer NOT NULL, method payment_method NOT NULL,
        source payment_source NOT NULL DEFAULT 'invoice',
        voucher_id uuid REFERENCES vouchers(id),
        tendered_amount integer, change_amount integer,
        paid_at timestamptz(3) NOT NULL DEFAULT now(),
        created_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    repo = new VouchersRepository({ db } as unknown as DrizzleService);

    const [plan] = await db
      .insert(plans)
      .values({ name: 'Home 20', speedMbps: 20, priceMonthly: 200_000 })
      .returning();
    if (!plan) throw new Error('plan seed failed');
    planId = plan.id;
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    // Delete children before parents: payments -> {invoices, vouchers};
    // reseller_ledger -> resellers; invoices -> customers; vouchers ->
    // resellers; customers has no remaining dependents once invoices are
    // gone; resellers last (vouchers + reseller_ledger both cleared).
    await db.delete(payments);
    await db.delete(resellerLedger);
    await db.delete(invoices);
    await db.delete(vouchers);
    await db.delete(customers);
    await db.delete(resellers);
  });

  let invoiceNoCounter = 0;

  const seedCustomer = async (over: Partial<typeof customers.$inferInsert> = {}) => {
    const [customer] = await db
      .insert(customers)
      .values({
        fullName: 'Budi Santoso',
        phone: '0811',
        address: 'Jl. A',
        planId,
        status: 'aktif',
        outstanding: 12_000,
        ...over,
      })
      .returning();
    if (!customer) throw new Error('customer seed failed');
    return customer;
  };

  // An unpaid invoice for `allocateToInvoices` (P3.D.3) to allocate the
  // voucher's face value against, oldest due date first.
  const seedInvoice = async (
    customerId: string,
    over: Partial<typeof invoices.$inferInsert> = {},
  ) => {
    invoiceNoCounter += 1;
    const [invoice] = await db
      .insert(invoices)
      .values({
        invoiceNo: `INV-TEST-${invoiceNoCounter}`,
        customerId,
        customerName: 'Budi Santoso',
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        amount: 20_000,
        status: 'pending',
        dueDate: '2026-06-10',
        ...over,
      })
      .returning();
    if (!invoice) throw new Error('invoice seed failed');
    return invoice;
  };

  const seedReseller = async (over: Partial<typeof resellers.$inferInsert> = {}) => {
    const [reseller] = await db
      .insert(resellers)
      .values({ name: 'Mitra A', area: 'Jakarta', commissionPct: 0.1, ...over })
      .returning();
    if (!reseller) throw new Error('reseller seed failed');
    return reseller;
  };

  const batchRows = (
    n: number,
    batchId: string,
    over: Partial<typeof vouchers.$inferInsert> = {},
  ) =>
    Array.from({ length: n }, (_, i) => ({
      code: `ASH-${batchId}-${String(i).padStart(2, '0')}`,
      batchId,
      profile: 'Hotspot 1 Hari',
      priceIdr: 5_000,
      durationDays: 1,
      ...over,
    }));

  it('bulk-inserts a batch and rejects duplicate codes', async () => {
    const created = await repo.createBatch(batchRows(3, 'B1'));
    expect(created).toBe(3);
    await expect(repo.createBatch(batchRows(1, 'B1'))).rejects.toThrow(); // code collision
  });

  it('lists by status with a real total and limit/offset', async () => {
    await repo.createBatch(batchRows(2, 'B2'));
    await repo.createBatch(batchRows(1, 'B3', { status: 'used' }));

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);

    const unused = await repo.list({ status: 'unused', limit: 50, offset: 0 });
    expect(unused.total).toBe(2);

    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  // ADR-0011 parity: FE status filter tabs need an `expired` count over the
  // FULL set, independent of the status filter applied to `items`.
  it('summary.expired counts every expired voucher regardless of the status filter', async () => {
    await repo.createBatch(batchRows(2, 'B5')); // unused
    await repo.createBatch(batchRows(1, 'B6', { status: 'used', priceIdr: 10_000 }));
    await repo.createBatch(batchRows(3, 'B7', { status: 'expired' }));

    const filtered = await repo.list({ status: 'unused', limit: 50, offset: 0 });
    expect(filtered.total).toBe(2); // filtered count
    expect(filtered.summary.total).toBe(6); // full-set
    expect(filtered.summary.unused).toBe(2);
    expect(filtered.summary.used).toBe(1);
    expect(filtered.summary.expired).toBe(3);
    expect(filtered.summary.revenue).toBe(10_000);
  });

  it('summary is zero-filled when no vouchers exist', async () => {
    const result = await repo.list({ limit: 50, offset: 0 });
    expect(result.summary).toEqual({ total: 0, unused: 0, used: 0, expired: 0, revenue: 0 });
  });

  describe('settle — the loket voucher settlement (P3.D.3, money code)', () => {
    it('settles a voucher, defaulting usedBy and stamping usedAt', async () => {
      await repo.createBatch(batchRows(1, 'B4'));
      const [item] = (await repo.list({ limit: 1, offset: 0 })).items;
      if (!item) throw new Error('seed failed');

      const redeemed = await repo.settle(item.id);
      expect(redeemed.status).toBe('used');
      expect(redeemed.usedAt).toBeInstanceOf(Date);
      expect(redeemed.usedBy).toBe('Admin (manual)');

      await expect(repo.settle('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
    });

    it('preserves an existing usedBy on settle', async () => {
      await repo.createBatch(batchRows(1, 'B5', { usedBy: 'Hotspot user 5' }));
      const [item] = (await repo.list({ limit: 1, offset: 0 })).items;
      if (!item) throw new Error('seed failed');
      const redeemed = await repo.settle(item.id);
      expect(redeemed.usedBy).toBe('Hotspot user 5');
    });

    it('an anonymous redeem (no customer, no reseller) still writes a payment row and succeeds', async () => {
      await repo.createBatch(batchRows(1, 'B6', { priceIdr: 7_500 }));
      const [item] = (await repo.list({ limit: 1, offset: 0 })).items;
      if (!item) throw new Error('seed failed');

      const redeemed = await repo.settle(item.id);
      expect(redeemed.status).toBe('used');

      const [payment] = await db.select().from(payments).where(eq(payments.voucherId, item.id));
      expect(payment).toBeDefined();
      expect(payment?.source).toBe('voucher');
      expect(payment?.amount).toBe(7_500);
      expect(payment?.invoiceId).toBeNull();
      expect(payment?.invoiceNo).toBeNull();
      expect(payment?.customerId).toBeNull();
      // Medium fix: exact-cash tendered/change so reconciliation stays balanced.
      expect(payment?.tenderedAmount).toBe(7_500);
      expect(payment?.changeAmount).toBe(0);
    });

    // Security-review fix: `customers.outstanding` is DERIVED (recomputed by
    // InvoicesService.refreshCustomerBilling from the invoices table on the
    // next billing event) — a direct decrement gets silently clobbered. The
    // voucher must instead allocate to unpaid invoices like a real payment,
    // then recompute outstanding from those same invoices.
    it('a loket sale to a subscriber allocates the voucher to their oldest unpaid invoice and recomputes outstanding from invoices', async () => {
      const customer = await seedCustomer();
      const invoice = await seedInvoice(customer.id, { amount: 20_000 });
      await repo.createBatch(batchRows(1, 'B7', { priceIdr: 5_000 }));
      const [item] = (await repo.list({ limit: 1, offset: 0 })).items;
      if (!item) throw new Error('seed failed');

      await repo.settle(item.id, { redeemedCustomerId: customer.id, usedBy: customer.fullName });

      const [refreshedInvoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoice.id));
      expect(refreshedInvoice?.paidAmount).toBe(5_000);
      expect(refreshedInvoice?.status).toBe('partial');
      expect(refreshedInvoice?.paidAt).toBeNull();

      const [refreshedCustomer] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, customer.id));
      expect(refreshedCustomer?.outstanding).toBe(15_000); // 20_000 - 5_000 (recomputed, not decremented)

      const [payment] = await db.select().from(payments).where(eq(payments.voucherId, item.id));
      expect(payment?.customerId).toBe(customer.id);
      expect(payment?.customerName).toBe(customer.fullName);
      expect(payment?.amount).toBe(5_000);
      // Medium fix: exact-cash tendered/change so the reconciliation cash
      // drawer roll-up (P3.A.4) stays balanced.
      expect(payment?.tenderedAmount).toBe(5_000);
      expect(payment?.changeAmount).toBe(0);
    });

    it('fully pays an invoice when the voucher covers its whole balance — flips to paid, stamps paidAt, zeroes outstanding', async () => {
      const customer = await seedCustomer();
      const invoice = await seedInvoice(customer.id, { amount: 5_000 });
      await repo.createBatch(batchRows(1, 'B8', { priceIdr: 5_000 }));
      const [item] = (await repo.list({ limit: 1, offset: 0 })).items;
      if (!item) throw new Error('seed failed');

      await repo.settle(item.id, { redeemedCustomerId: customer.id });

      const [refreshedInvoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoice.id));
      expect(refreshedInvoice?.status).toBe('paid');
      expect(refreshedInvoice?.paidAmount).toBe(5_000);
      expect(refreshedInvoice?.paidAt).toBeInstanceOf(Date);

      const [refreshedCustomer] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, customer.id));
      expect(refreshedCustomer?.outstanding).toBe(0);
    });

    it("spills the remainder to the next oldest unpaid invoice when the voucher exceeds the first one's balance", async () => {
      const customer = await seedCustomer();
      const older = await seedInvoice(customer.id, {
        amount: 3_000,
        dueDate: '2026-05-10',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
      });
      const newer = await seedInvoice(customer.id, {
        amount: 10_000,
        dueDate: '2026-06-10',
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
      });
      await repo.createBatch(batchRows(1, 'B9', { priceIdr: 5_000 }));
      const [item] = (await repo.list({ limit: 1, offset: 0 })).items;
      if (!item) throw new Error('seed failed');

      await repo.settle(item.id, { redeemedCustomerId: customer.id });

      const [refreshedOlder] = await db.select().from(invoices).where(eq(invoices.id, older.id));
      expect(refreshedOlder?.status).toBe('paid');
      expect(refreshedOlder?.paidAmount).toBe(3_000);

      const [refreshedNewer] = await db.select().from(invoices).where(eq(invoices.id, newer.id));
      expect(refreshedNewer?.status).toBe('partial');
      expect(refreshedNewer?.paidAmount).toBe(2_000); // 5_000 - 3_000 spilled over

      const [refreshedCustomer] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, customer.id));
      // older is now 'paid' (excluded from the unpaid sum); newer still owes 8_000.
      expect(refreshedCustomer?.outstanding).toBe(8_000);
    });

    it('leaves any voucher amount beyond total owed unallocated — outstanding floors at zero, payment still records the full amount', async () => {
      const customer = await seedCustomer();
      await seedInvoice(customer.id, { amount: 2_000 });
      await repo.createBatch(batchRows(1, 'B10', { priceIdr: 5_000 }));
      const [item] = (await repo.list({ limit: 1, offset: 0 })).items;
      if (!item) throw new Error('seed failed');

      await repo.settle(item.id, { redeemedCustomerId: customer.id });

      const [refreshedCustomer] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, customer.id));
      expect(refreshedCustomer?.outstanding).toBe(0);

      const [payment] = await db.select().from(payments).where(eq(payments.voucherId, item.id));
      expect(payment?.amount).toBe(5_000); // full face value recorded regardless of what got allocated
    });

    it('does not touch outstanding when the customer has no unpaid invoices', async () => {
      const customer = await seedCustomer({ outstanding: 999 }); // stale value — must be left alone
      await repo.createBatch(batchRows(1, 'B11', { priceIdr: 5_000 }));
      const [item] = (await repo.list({ limit: 1, offset: 0 })).items;
      if (!item) throw new Error('seed failed');

      await repo.settle(item.id, { redeemedCustomerId: customer.id });

      const [refreshedCustomer] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, customer.id));
      expect(refreshedCustomer?.outstanding).toBe(999);
    });

    it('a reseller-attributed redeem posts exactly one commission entry', async () => {
      const reseller = await seedReseller({ commissionPct: 0.1 });
      await repo.createBatch(batchRows(1, 'B9', { priceIdr: 5_000, resellerId: reseller.id }));
      const [item] = (await repo.list({ limit: 1, offset: 0 })).items;
      if (!item) throw new Error('seed failed');

      await repo.settle(item.id);

      const ledgerRows = await db
        .select()
        .from(resellerLedger)
        .where(eq(resellerLedger.resellerId, reseller.id));
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]?.type).toBe('commission');
      expect(ledgerRows[0]?.amount).toBe(500); // 10% of 5_000
      expect(ledgerRows[0]?.ref).toBe(`voucher:${item.id}`);

      const [refreshedReseller] = await db
        .select()
        .from(resellers)
        .where(eq(resellers.id, reseller.id));
      expect(refreshedReseller?.balance).toBe(500);
    });

    it('does not post a commission when the reseller has a zero commission rate', async () => {
      const reseller = await seedReseller({ commissionPct: 0 });
      await repo.createBatch(batchRows(1, 'B10', { priceIdr: 5_000, resellerId: reseller.id }));
      const [item] = (await repo.list({ limit: 1, offset: 0 })).items;
      if (!item) throw new Error('seed failed');

      await repo.settle(item.id);

      const ledgerRows = await db
        .select()
        .from(resellerLedger)
        .where(eq(resellerLedger.resellerId, reseller.id));
      expect(ledgerRows).toHaveLength(0);
    });

    it('a redeem input resellerId overrides the voucher batch reseller', async () => {
      const batchReseller = await seedReseller({ name: 'Batch mitra', commissionPct: 0.1 });
      const overrideReseller = await seedReseller({ name: 'Override mitra', commissionPct: 0.2 });
      await repo.createBatch(
        batchRows(1, 'B11', { priceIdr: 5_000, resellerId: batchReseller.id }),
      );
      const [item] = (await repo.list({ limit: 1, offset: 0 })).items;
      if (!item) throw new Error('seed failed');

      await repo.settle(item.id, { resellerId: overrideReseller.id });

      const batchLedger = await db
        .select()
        .from(resellerLedger)
        .where(eq(resellerLedger.resellerId, batchReseller.id));
      expect(batchLedger).toHaveLength(0);

      const overrideLedger = await db
        .select()
        .from(resellerLedger)
        .where(eq(resellerLedger.resellerId, overrideReseller.id));
      expect(overrideLedger).toHaveLength(1);
      expect(overrideLedger[0]?.amount).toBe(1_000); // 20% of 5_000
    });

    // Money-code invariant: a retried/duplicated settle call must never
    // double-write. Second call is an idempotent no-op.
    it('a second settle on an already-used voucher does not double-post payment, invoice allocation or commission', async () => {
      const customer = await seedCustomer();
      const invoice = await seedInvoice(customer.id, { amount: 20_000 });
      const reseller = await seedReseller({ commissionPct: 0.1 });
      await repo.createBatch(batchRows(1, 'B12', { priceIdr: 5_000, resellerId: reseller.id }));
      const [item] = (await repo.list({ limit: 1, offset: 0 })).items;
      if (!item) throw new Error('seed failed');

      await repo.settle(item.id, { redeemedCustomerId: customer.id, usedBy: customer.fullName });
      const second = await repo.settle(item.id, {
        redeemedCustomerId: customer.id,
        usedBy: customer.fullName,
      });
      expect(second.status).toBe('used'); // no-op, no throw

      const paymentRows = await db.select().from(payments).where(eq(payments.voucherId, item.id));
      expect(paymentRows).toHaveLength(1);

      const [refreshedInvoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoice.id));
      expect(refreshedInvoice?.paidAmount).toBe(5_000); // allocated exactly once

      const [refreshedCustomer] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, customer.id));
      expect(refreshedCustomer?.outstanding).toBe(15_000); // 20_000 - 5_000, exactly once

      const ledgerRows = await db
        .select()
        .from(resellerLedger)
        .where(eq(resellerLedger.resellerId, reseller.id));
      expect(ledgerRows).toHaveLength(1);
    });
  });
});
