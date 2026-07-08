import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import {
  type NewPaymentIntent,
  invoices,
  paymentIntents,
} from '../../infrastructure/database/schema/invoices.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { applyMigrations } from '../../test-utils/apply-migrations';
import { PaymentIntentsRepository } from './payment-intents.repository';

/**
 * Real Postgres integration test for PaymentIntentsRepository. Requires
 * Docker. Schema comes from the REAL `drizzle/*.sql` migrations (TEST-H1) —
 * the single source of truth — instead of a hand-mirrored `CREATE TABLE`
 * DDL that could silently drift more permissive than production.
 */
describe('PaymentIntentsRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: PaymentIntentsRepository;
  let invoiceId: string;
  let customerAId: string;
  let invoiceBId: string;
  let customerBId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await applyMigrations(pool);

    const [plan] = await db
      .insert(plans)
      .values({ name: 'Home 50', speedMbps: 50, priceMonthly: 200_000 })
      .returning();
    if (!plan) throw new Error('plan seed missing');
    const [customer] = await db
      .insert(customers)
      .values({ fullName: 'Budi Santoso', phone: '0811', address: 'Jl. Mawar', planId: plan.id })
      .returning();
    if (!customer) throw new Error('customer seed missing');
    const [invoice] = await db
      .insert(invoices)
      .values({
        customerId: customer.id,
        customerName: customer.fullName,
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        amount: 200_000,
        taxAmount: 22_000,
        dueDate: '2026-06-10',
      })
      .returning();
    if (!invoice) throw new Error('invoice seed missing');
    invoiceId = invoice.id;
    customerAId = customer.id;

    // A second customer + invoice (P3.C.3): proves listPendingByCustomer
    // scopes strictly via the invoices.customer_id join, never leaking one
    // customer's intents into another's /me payload.
    const [customerB] = await db
      .insert(customers)
      .values({ fullName: 'Siti Aminah', phone: '0822', address: 'Jl. Melati', planId: plan.id })
      .returning();
    if (!customerB) throw new Error('customerB seed missing');
    customerBId = customerB.id;
    const [invoiceB] = await db
      .insert(invoices)
      .values({
        customerId: customerB.id,
        customerName: customerB.fullName,
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        amount: 200_000,
        taxAmount: 22_000,
        dueDate: '2026-06-10',
      })
      .returning();
    if (!invoiceB) throw new Error('invoiceB seed missing');
    invoiceBId = invoiceB.id;

    repo = new PaymentIntentsRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(paymentIntents);
  });

  const pending = (over: Partial<NewPaymentIntent> = {}): NewPaymentIntent => ({
    invoiceId,
    invoiceNo: 'INV-2026-100',
    customerName: 'Budi Santoso',
    amount: 222_000,
    channel: 'qris',
    qrPayload: 'ID.MOCK.QRIS|qris|INV-2026-100|222000',
    expiresAt: new Date('2026-06-17T00:00:00.000Z'),
    ...over,
  });

  it('creates an intent and reads it back with its rails preserved', async () => {
    const created = await repo.create(
      pending({ channel: 'va_bca', qrPayload: null, vaNumber: '8808123' }),
    );
    const found = await repo.findById(created.id);
    expect(found?.channel).toBe('va_bca');
    expect(found?.vaNumber).toBe('8808123');
    expect(found?.qrPayload).toBeNull();
    expect(found?.status).toBe('pending');
    expect(found?.expiresAt).toBeInstanceOf(Date);
  });

  it('returns null for an unknown intent', async () => {
    expect(await repo.findById('00000000-0000-0000-0000-0000000000ff')).toBeNull();
  });

  it('marks an intent paid with a paidAt timestamp', async () => {
    const created = await repo.create(pending());
    const paid = await repo.markPaid(created.id);
    expect(paid.status).toBe('paid');
    expect(paid.paidAt).toBeInstanceOf(Date);
  });

  it('rejects marking an unknown intent paid', async () => {
    await expect(repo.markPaid('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });

  it('marks an intent expired', async () => {
    const created = await repo.create(pending());
    await repo.markExpired(created.id);
    const found = await repo.findById(created.id);
    expect(found?.status).toBe('expired');
  });

  it('expireStalePending only expires pending intents past their window', async () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    const stale = await repo.create(pending({ expiresAt: new Date('2026-06-19T00:00:00.000Z') }));
    const fresh = await repo.create(pending({ expiresAt: new Date('2026-06-21T00:00:00.000Z') }));
    const alreadyPaid = await repo.create(
      pending({ expiresAt: new Date('2026-06-18T00:00:00.000Z') }),
    );
    await repo.markPaid(alreadyPaid.id);

    const expired = await repo.expireStalePending(now);

    expect(expired).toBe(1);
    expect((await repo.findById(stale.id))?.status).toBe('expired');
    expect((await repo.findById(fresh.id))?.status).toBe('pending');
    expect((await repo.findById(alreadyPaid.id))?.status).toBe('paid');
  });

  describe('listPendingByCustomer (P3.C.3)', () => {
    it('returns only the target customer pending, non-expired intents', async () => {
      const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

      // Customer A: one resumable intent, one already paid, and one whose
      // window lapsed but hasn't been swept by expireStalePending yet —
      // status is still 'pending', so only the `expiresAt > now()` clause
      // keeps it out of the resumable set.
      const resumable = await repo.create(
        pending({ invoiceId, channel: 'qris', expiresAt: inOneHour }),
      );
      const paidIntent = await repo.create(
        pending({ invoiceId, channel: 'qris', expiresAt: inOneHour }),
      );
      await repo.markPaid(paidIntent.id);
      const lapsedIntent = await repo.create(
        pending({ invoiceId, channel: 'qris', expiresAt: oneHourAgo }),
      );

      // Customer B: a resumable intent of their own — must never leak into
      // customer A's result.
      await repo.create(
        pending({
          invoiceId: invoiceBId,
          invoiceNo: 'INV-2026-101',
          customerName: 'Siti Aminah',
          channel: 'va_bca',
          qrPayload: null,
          vaNumber: '8808999999',
          expiresAt: inOneHour,
        }),
      );

      const result = await repo.listPendingByCustomer(customerAId);

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe(resumable.id);
      expect(result[0]?.status).toBe('pending');
      expect(result.some((row) => row.id === paidIntent.id)).toBe(false);
      expect(result.some((row) => row.id === lapsedIntent.id)).toBe(false);

      const resultB = await repo.listPendingByCustomer(customerBId);
      expect(resultB).toHaveLength(1);
      expect(resultB[0]?.channel).toBe('va_bca');
    });
  });
});
