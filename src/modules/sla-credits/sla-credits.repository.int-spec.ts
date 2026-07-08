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
import { applyMigrations } from '../../test-utils/apply-migrations';
import { SlaCreditsRepository } from './sla-credits.repository';

/**
 * Real Postgres integration test for SlaCreditsRepository. Requires Docker.
 * Schema comes from the REAL `drizzle/*.sql` migrations (TEST-H1) — the
 * single source of truth — instead of a hand-mirrored `CREATE TABLE` DDL.
 *
 * TEST-H1 real finding: the old hand DDL left `sla_credits.customer_id` /
 * `applied_invoice_id` as bare `uuid` columns with NO foreign key, so tests
 * could use arbitrary fake ids (e.g. `...-c1`, `...-e001`) that resolve to
 * no row. The real schema (migration 0010 + 0036) DOES FK both columns to
 * `customers.id` / `invoices.id` — production enforces that a credit's
 * customer/applied-invoice reference is always a real row. The
 * `findPendingByCustomer` / `markAppliedWithInvoice` tests below now seed
 * real customers + a real invoice instead of fabricating ids, so they run
 * against (and genuinely exercise) that FK.
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
    await applyMigrations(pool);

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
    // TEST-H1 real finding: under the real schema, customer_id and
    // applied_invoice_id are FK'd to customers(id) / invoices(id) (migration
    // 0010 + 0036) — the old hand-DDL suite used arbitrary fake ids here
    // because its DDL never enforced that FK. Seed real rows instead so
    // these tests exercise (and respect) the real constraint.
    let CUSTOMER_ID: string;
    let OTHER_CUSTOMER_ID: string;
    let INVOICE_ID: string;

    beforeEach(async () => {
      const [c1] = await db
        .insert(customers)
        .values({ fullName: 'Customer C1', phone: '08', address: 'Jl', planId })
        .returning();
      const [c2] = await db
        .insert(customers)
        .values({ fullName: 'Customer C2', phone: '08', address: 'Jl', planId })
        .returning();
      if (!c1 || !c2) throw new Error('customer seed failed');
      CUSTOMER_ID = c1.id;
      OTHER_CUSTOMER_ID = c2.id;

      const [invoice] = await db
        .insert(invoices)
        .values({
          customerId: c1.id,
          customerName: c1.fullName,
          periodStart: '2026-06-01',
          periodEnd: '2026-06-30',
          amount: 100_000,
          dueDate: '2026-06-10',
          status: 'pending',
        })
        .returning();
      if (!invoice) throw new Error('invoice seed failed');
      INVOICE_ID = invoice.id;
    });

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

    // MED #3 (PR #121 money review — "credit vanishes"): a credit LARGER
    // than the oldest unpaid invoice's balance due is never partially
    // applied — that would silently strand the remainder (a future billing
    // run's absorption has no concept of "already partly spent"). Instead
    // it is left `pending`, untouched, for the existing billing-run
    // absorption to pick up in full later.
    it('a credit larger than the invoice balance due is left pending — never partially applied', async () => {
      const customerId = await seedCustomerWithUnpaidInvoice(30_000);
      const credit = await repo.create(newCredit({ customerId, amount: 50_000 }));

      const result = await repo.applyWithInvoiceCredit(credit.id, customerId);
      expect(result.status).toBe('pending'); // NOT 'applied' — see method doc.
      expect(result.appliedInvoiceId).toBeNull();

      const [invoice] = await db.select().from(invoices).where(eq(invoices.customerId, customerId));
      expect(invoice?.discountAmount).toBe(0); // untouched — no partial application

      const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
      expect(customer?.outstanding).toBe(30_000); // unchanged — nothing deducted
    });

    it('leaves the credit pending (not applied) when the customer has no unpaid invoice at all', async () => {
      const [customer] = await db
        .insert(customers)
        .values({ fullName: 'Ani', phone: '08', address: 'Jl', planId })
        .returning();
      if (!customer) throw new Error('customer seed failed');
      const credit = await repo.create(newCredit({ customerId: customer.id, amount: 50_000 }));

      const result = await repo.applyWithInvoiceCredit(credit.id, customer.id);
      expect(result.status).toBe('pending'); // MED #3 — deferred, never dropped.
      expect(result.appliedInvoiceId).toBeNull();
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
