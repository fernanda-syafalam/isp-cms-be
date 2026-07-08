import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { invoices } from '../../infrastructure/database/schema/invoices.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { slaCredits } from '../../infrastructure/database/schema/sla-credits.schema';
import { SlaCreditsRepository } from './sla-credits.repository';

/**
 * Real Postgres integration test for SlaCreditsRepository. Requires Docker.
 * `sla_credits.customer_id` / `ticket_id` are left as bare uuid (no FK, no
 * NOT NULL) so most tests below can use arbitrary fake ids, mirroring
 * migration 0010 minus those FKs. `customers` / `plans` / `invoices` ARE
 * created for real (mirroring migrations 0002-0004, 0043, 0048), because
 * `applyWithInvoiceCredit` (outstanding-integrity fix) reads/writes them for
 * real — its own describe block below seeds an actual customer + invoice
 * rather than a fake id.
 */
describe('SlaCreditsRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: SlaCreditsRepository;
  let planId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE sla_credit_status AS ENUM ('pending', 'applied', 'void');
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
      CREATE TYPE invoice_status AS ENUM ('draft', 'pending', 'partial', 'overdue', 'paid');
      CREATE TYPE invoice_type AS ENUM ('regular', 'adjustment');
      CREATE SEQUENCE invoice_no_seq START WITH 100;
      CREATE TABLE invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_no varchar(32) NOT NULL UNIQUE
          DEFAULT ('INV-' || to_char(now(), 'YYYY') || '-' || nextval('invoice_no_seq')),
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
      CREATE UNIQUE INDEX invoices_customer_period_idx ON invoices (customer_id, period_start) WHERE type = 'regular';
      CREATE TABLE sla_credits (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id uuid,
        customer_name varchar(120) NOT NULL,
        amount integer NOT NULL,
        reason varchar(200) NOT NULL,
        ticket_id uuid,
        ticket_code varchar(40),
        status sla_credit_status NOT NULL DEFAULT 'pending',
        applied_invoice_id uuid,
        applied_at timestamptz(3),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    const [plan] = await db
      .insert(plans)
      .values({ name: 'Home 20', speedMbps: 20, priceMonthly: 200_000 })
      .returning();
    if (!plan) throw new Error('plan seed failed');
    planId = plan.id;

    repo = new SlaCreditsRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(slaCredits);
    await db.delete(invoices);
    await db.delete(customers);
  });

  const newCredit = (over: Partial<typeof slaCredits.$inferInsert> = {}) => ({
    customerId: null,
    customerName: 'Budi',
    amount: 50_000,
    reason: 'Gangguan',
    ticketId: null,
    ticketCode: null,
    ...over,
  });

  it('creates a credit defaulting to pending', async () => {
    const credit = await repo.create(newCredit());
    expect(credit.status).toBe('pending');
    expect(credit.appliedAt).toBeNull();
  });

  it('lists all credits with total, limit/offset paging, and full-set summary', async () => {
    await repo.create(newCredit({ customerName: 'Ani', amount: 50_000 }));
    await repo.create(newCredit({ customerName: 'Budi', amount: 30_000, status: 'applied' }));
    await repo.create(newCredit({ customerName: 'Citra', amount: 20_000, status: 'void' }));

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.items).toHaveLength(3);

    // Summary is over all rows regardless of filters.
    // activeAmount = 50_000 (pending) + 30_000 (applied) = 80_000 (void excluded)
    expect(all.summary.total).toBe(3);
    expect(all.summary.activeAmount).toBe(80_000);
    expect(all.summary.pending).toBe(1);
    expect(all.summary.applied).toBe(1);
    expect(all.summary.void).toBe(1);

    // Paging: limit keeps items per page, but total + summary stay full-set
    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
    expect(page.summary.total).toBe(3);
    expect(page.summary.activeAmount).toBe(80_000);
    expect(page.summary.void).toBe(1);
  });

  it('summary is zero when no credits exist', async () => {
    const result = await repo.list({ limit: 50, offset: 0 });
    expect(result.summary).toEqual({
      total: 0,
      activeAmount: 0,
      pending: 0,
      applied: 0,
      void: 0,
    });
  });

  it('q search filters items and total by customerName or reason; summary is invariant', async () => {
    await repo.create(newCredit({ customerName: 'Ani Rahayu', reason: 'Gangguan 1 hari' }));
    await repo.create(
      newCredit({
        customerName: 'Budi Santoso',
        reason: 'Gangguan 2 hari',
        amount: 30_000,
        status: 'applied',
      }),
    );
    await repo.create(
      newCredit({ customerName: 'Citra Dewi', reason: 'Downtime', amount: 20_000 }),
    );

    // Full-set summary: 50_000 (pending Ani) + 30_000 (applied Budi) + 20_000 (pending Citra) = 100_000
    const baseSummary = (await repo.list({ limit: 50, offset: 0 })).summary;
    expect(baseSummary.activeAmount).toBe(100_000);
    expect(baseSummary.pending).toBe(2);
    expect(baseSummary.applied).toBe(1);

    // Search by customerName substring
    const byName = await repo.list({ q: 'Ani', limit: 50, offset: 0 });
    expect(byName.total).toBe(1);
    expect(byName.items[0]?.customerName).toBe('Ani Rahayu');
    // Summary is unchanged — it ignores q
    expect(byName.summary).toEqual(baseSummary);

    // Search by reason substring
    const byReason = await repo.list({ q: 'Gangguan', limit: 50, offset: 0 });
    expect(byReason.total).toBe(2);
    expect(byReason.summary).toEqual(baseSummary);

    // No match
    const noMatch = await repo.list({ q: 'nonexistent', limit: 50, offset: 0 });
    expect(noMatch.total).toBe(0);
    expect(noMatch.items).toHaveLength(0);
    // Summary still full-set
    expect(noMatch.summary).toEqual(baseSummary);
  });

  it('sorts by amount asc and desc', async () => {
    await repo.create(newCredit({ customerName: 'A', amount: 10_000 }));
    await repo.create(newCredit({ customerName: 'B', amount: 50_000 }));
    await repo.create(newCredit({ customerName: 'C', amount: 30_000 }));

    const asc = await repo.list({ sort: 'amount', order: 'asc', limit: 50, offset: 0 });
    const amounts = asc.items.map((i) => i.amount);
    expect(amounts).toEqual([10_000, 30_000, 50_000]);

    const desc = await repo.list({ sort: 'amount', order: 'desc', limit: 50, offset: 0 });
    const amountsDesc = desc.items.map((i) => i.amount);
    expect(amountsDesc).toEqual([50_000, 30_000, 10_000]);
  });

  it('falls back to createdAt desc when sort key is unknown', async () => {
    // Insert in known order via explicit timestamps is not feasible in integration tests;
    // we just verify the query does not throw and returns all rows.
    await repo.create(newCredit({ customerName: 'A' }));
    await repo.create(newCredit({ customerName: 'B' }));
    const result = await repo.list({ sort: 'unknownKey', order: 'asc', limit: 50, offset: 0 });
    expect(result.total).toBe(2);
  });

  it('apply stamps applied_at; void leaves it; missing-id rejects', async () => {
    const credit = await repo.create(newCredit());
    const applied = await repo.apply(credit.id);
    expect(applied.status).toBe('applied');
    expect(applied.appliedAt).toBeInstanceOf(Date);

    const other = await repo.create(newCredit());
    const voided = await repo.void(other.id);
    expect(voided.status).toBe('void');
    expect(voided.appliedAt).toBeNull();

    await expect(repo.apply('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });

  it('counts only pending credits for the command-center badge', async () => {
    await repo.create(newCredit());
    await repo.create(newCredit({ status: 'pending' }));
    await repo.create(newCredit({ status: 'applied' }));
    await repo.create(newCredit({ status: 'void' }));
    expect(await repo.countPending()).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Billing absorption (P3.A.4): findPendingByCustomer + markAppliedWithInvoice
  // ---------------------------------------------------------------------------

  describe('findPendingByCustomer / markAppliedWithInvoice', () => {
    const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c1';
    const OTHER_CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c2';
    const INVOICE_ID = '00000000-0000-0000-0000-00000000e001';

    it("returns only this customer's pending credits, oldest first", async () => {
      const first = await repo.create(newCredit({ customerId: CUSTOMER_ID, amount: 20_000 }));
      const second = await repo.create(newCredit({ customerId: CUSTOMER_ID, amount: 30_000 }));
      // Excluded: another customer, and an already-applied credit for this one.
      await repo.create(newCredit({ customerId: OTHER_CUSTOMER_ID, amount: 40_000 }));
      const applied = await repo.create(newCredit({ customerId: CUSTOMER_ID, amount: 50_000 }));
      await repo.apply(applied.id);

      const pending = await repo.findPendingByCustomer(CUSTOMER_ID);
      expect(pending.map((c) => c.id)).toEqual([first.id, second.id]);
    });

    it('returns an empty array for a customer with no pending credits', async () => {
      expect(await repo.findPendingByCustomer(OTHER_CUSTOMER_ID)).toEqual([]);
    });

    it('marks a batch of credits applied and stamps the absorbing invoice id', async () => {
      const a = await repo.create(newCredit({ customerId: CUSTOMER_ID, amount: 20_000 }));
      const b = await repo.create(newCredit({ customerId: CUSTOMER_ID, amount: 30_000 }));

      const count = await repo.markAppliedWithInvoice([a.id, b.id], INVOICE_ID);
      expect(count).toBe(2);

      const pending = await repo.findPendingByCustomer(CUSTOMER_ID);
      expect(pending).toEqual([]);

      const [aRow] = await db.select().from(slaCredits).where(eq(slaCredits.id, a.id));
      expect(aRow?.status).toBe('applied');
      expect(aRow?.appliedInvoiceId).toBe(INVOICE_ID);
      expect(aRow?.appliedAt).toBeInstanceOf(Date);
    });

    it('is a no-op for an empty batch and never touches an already-applied credit', async () => {
      const applied = await repo.create(newCredit({ customerId: CUSTOMER_ID }));
      await repo.apply(applied.id);

      expect(await repo.markAppliedWithInvoice([], INVOICE_ID)).toBe(0);
      // Re-applying an already-applied credit with a different invoice id is a
      // no-op (WHERE status = 'pending' excludes it) — appliedInvoiceId stays null.
      const count = await repo.markAppliedWithInvoice([applied.id], INVOICE_ID);
      expect(count).toBe(0);
      const [row] = await db.select().from(slaCredits).where(eq(slaCredits.id, applied.id));
      expect(row?.appliedInvoiceId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // applyWithInvoiceCredit (outstanding-integrity fix): a credit that resolves
  // to a customer is now applied via a REAL discount line on a real invoice —
  // never a hand-computed `outstanding - amount` write.
  // ---------------------------------------------------------------------------

  describe('applyWithInvoiceCredit', () => {
    async function seedCustomerWithUnpaidInvoice(balance: number): Promise<string> {
      const [customer] = await db
        .insert(customers)
        .values({ fullName: 'Budi', phone: '08', address: 'Jl', planId })
        .returning();
      if (!customer) throw new Error('customer seed failed');
      await db.insert(invoices).values({
        customerId: customer.id,
        customerName: customer.fullName,
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        amount: balance,
        dueDate: '2026-06-10',
        status: 'pending',
      });
      await db.update(customers).set({ outstanding: balance }).where(eq(customers.id, customer.id));
      return customer.id;
    }

    it('deducts a real invoice discount line and refreshes outstanding', async () => {
      const customerId = await seedCustomerWithUnpaidInvoice(200_000);
      const credit = await repo.create(newCredit({ customerId, amount: 50_000 }));

      const applied = await repo.applyWithInvoiceCredit(credit.id, customerId);
      expect(applied.status).toBe('applied');
      expect(applied.appliedAt).toBeInstanceOf(Date);
      expect(applied.appliedInvoiceId).not.toBeNull();

      const [invoice] = await db.select().from(invoices).where(eq(invoices.customerId, customerId));
      expect(invoice?.discountAmount).toBe(50_000);
      expect(applied.appliedInvoiceId).toBe(invoice?.id);

      const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
      expect(customer?.outstanding).toBe(150_000);
    });

    it('caps the discount at the invoice balance due — never a negative balance', async () => {
      const customerId = await seedCustomerWithUnpaidInvoice(30_000);
      const credit = await repo.create(newCredit({ customerId, amount: 50_000 }));

      await repo.applyWithInvoiceCredit(credit.id, customerId);

      const [invoice] = await db.select().from(invoices).where(eq(invoices.customerId, customerId));
      expect(invoice?.discountAmount).toBe(30_000); // capped, not 50_000

      const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
      expect(customer?.outstanding).toBe(0);
    });

    it('transitions to applied with a null appliedInvoiceId when the customer has no unpaid invoice', async () => {
      const [customer] = await db
        .insert(customers)
        .values({ fullName: 'Ani', phone: '08', address: 'Jl', planId })
        .returning();
      if (!customer) throw new Error('customer seed failed');
      const credit = await repo.create(newCredit({ customerId: customer.id, amount: 50_000 }));

      const applied = await repo.applyWithInvoiceCredit(credit.id, customer.id);
      expect(applied.status).toBe('applied');
      expect(applied.appliedInvoiceId).toBeNull();
    });

    it('is idempotent — re-applying an already-applied credit is a no-op', async () => {
      const customerId = await seedCustomerWithUnpaidInvoice(200_000);
      const credit = await repo.create(newCredit({ customerId, amount: 50_000 }));
      await repo.applyWithInvoiceCredit(credit.id, customerId);

      const second = await repo.applyWithInvoiceCredit(credit.id, customerId);
      expect(second.status).toBe('applied');

      // Discount was only ever applied once.
      const [invoice] = await db.select().from(invoices).where(eq(invoices.customerId, customerId));
      expect(invoice?.discountAmount).toBe(50_000);
    });

    // Regression for the silent-wipe bug: the credit is backed by a real
    // discount line on a real invoice row, so re-deriving `outstanding` from
    // `sumUnpaidByCustomer`'s exact expression — exactly what a SUBSEQUENT
    // billing run / payment recompute does — reproduces the SAME number,
    // never the pre-credit balance. Before this fix, the deduction was a
    // bare in-memory delta with no backing row, so this recompute would
    // have erased it.
    it('regression: the credit survives a subsequent outstanding recompute', async () => {
      const customerId = await seedCustomerWithUnpaidInvoice(200_000);
      const credit = await repo.create(newCredit({ customerId, amount: 50_000 }));
      await repo.applyWithInvoiceCredit(credit.id, customerId);

      const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
      expect(customer?.outstanding).toBe(150_000);

      const [recomputed] = await db
        .select({
          total: sql<string>`coalesce(sum(${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount} - ${invoices.discountAmount} - ${invoices.paidAmount}), 0)`,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.customerId, customerId),
            inArray(invoices.status, ['pending', 'partial', 'overdue']),
          ),
        );
      expect(Number(recomputed?.total ?? 0)).toBe(150_000);
    });

    // Concurrency (mirrors the recordPayment / CustomersRepository
    // .applyProration lock discipline): two DIFFERENT pending credits for the
    // SAME customer applied concurrently must both land against the invoice
    // — the customer-row FOR UPDATE lock serializes the final recompute so
    // neither commit clobbers the other.
    it('concurrency: two concurrent applies for the same customer never lose either deduction', async () => {
      const customerId = await seedCustomerWithUnpaidInvoice(200_000);
      const creditA = await repo.create(newCredit({ customerId, amount: 40_000 }));
      const creditB = await repo.create(newCredit({ customerId, amount: 60_000 }));

      await Promise.all([
        repo.applyWithInvoiceCredit(creditA.id, customerId),
        repo.applyWithInvoiceCredit(creditB.id, customerId),
      ]);

      const [invoice] = await db.select().from(invoices).where(eq(invoices.customerId, customerId));
      expect(invoice?.discountAmount).toBe(100_000); // 40k + 60k — neither lost

      const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
      expect(customer?.outstanding).toBe(100_000); // 200k - 100k
    });
  });
});
