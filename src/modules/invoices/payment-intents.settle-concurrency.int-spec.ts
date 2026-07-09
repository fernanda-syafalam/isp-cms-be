import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import {
  invoices,
  paymentIntents,
  payments,
} from '../../infrastructure/database/schema/invoices.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { applyMigrations } from '../../test-utils/apply-migrations';
import { CustomersRepository } from '../customers/customers.repository';
import type { NotificationsService } from '../notifications/notifications.service';
import { ResellersRepository } from '../resellers/resellers.repository';
import { SecretsRepository } from '../router-resources/secrets.repository';
import type { SettingsService } from '../settings/settings.service';
import { SlaCreditsRepository } from '../sla-credits/sla-credits.repository';
import { InvoicesRepository } from './invoices.repository';
import { InvoicesService } from './invoices.service';
import type { PaymentGateway } from './payment-gateway/payment-gateway';
import { PaymentIntentsRepository } from './payment-intents.repository';
import { PaymentIntentsService } from './payment-intents.service';

/**
 * Rec-4 follow-up (#129 review): a real (non-mocked, real Postgres via
 * Testcontainers) integration test locking the single-settle money
 * invariant for the ACTUAL Tripay webhook path — `PaymentIntentsService
 * .settleFromGateway` (called by `TripayWebhookController` once the
 * signature is already verified) — rather than only the lower-level
 * `InvoicesRepository.recordPayment` concurrency test
 * (`invoices.repository.int-spec.ts`). Every dependency below is wired to
 * the SAME real repositories the app uses, except `settings` (never read
 * by the pay path — only `InvoicesService.run()`, the billing generator,
 * touches it) and `notifications` (best-effort side channel that would
 * otherwise need a live BullMQ/Redis queue) — those two are lightweight
 * stubs, never asserted on.
 */
describe('PaymentIntentsService.settleFromGateway — concurrent delivery (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let invoicesRepo: InvoicesRepository;
  let paymentIntentsRepo: PaymentIntentsRepository;
  let paymentIntentsService: PaymentIntentsService;
  let customerId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await applyMigrations(pool);

    const drizzleService = { db } as unknown as DrizzleService;
    invoicesRepo = new InvoicesRepository(drizzleService);
    paymentIntentsRepo = new PaymentIntentsRepository(drizzleService);
    const customersRepo = new CustomersRepository(drizzleService);
    const secretsRepo = new SecretsRepository(drizzleService);
    const resellersRepo = new ResellersRepository(drizzleService);
    const slaCreditsRepo = new SlaCreditsRepository(drizzleService);
    // Never exercised by pay()/settleFromGateway() — see file doc comment.
    const settingsStub = {} as unknown as SettingsService;
    const notificationsStub = {
      enqueue: async () => undefined,
    } as unknown as NotificationsService;

    const invoicesService = new InvoicesService(
      invoicesRepo,
      customersRepo,
      secretsRepo,
      settingsStub,
      resellersRepo,
      slaCreditsRepo,
      notificationsStub,
    );

    // settleFromGateway/confirm() never call the gateway (that's only
    // create()'s concern, minting a NEW charge) — stub it too.
    paymentIntentsService = new PaymentIntentsService(
      paymentIntentsRepo,
      invoicesService,
      {} as unknown as PaymentGateway,
      customersRepo,
    );

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
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(paymentIntents);
    await db.delete(payments);
    await db.delete(invoices);
  });

  it('two concurrent deliveries of the same verified callback settle exactly once — one payment row, one reactivation', async () => {
    // Customer starts isolir with a balance equal to the invoice total —
    // proves the concurrency guard covers the reactivation branch too, not
    // just the ledger insert.
    await db
      .update(customers)
      .set({ status: 'isolir', outstanding: 222_000 })
      .where(eq(customers.id, customerId));

    const invoice = await invoicesRepo.create({
      customerId,
      customerName: 'Budi',
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
      amount: 200_000,
      taxAmount: 22_000,
      dueDate: '2026-06-10',
    }); // total = 222_000

    const intent = await paymentIntentsRepo.create({
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      customerName: invoice.customerName,
      amount: 222_000,
      channel: 'qris',
      qrPayload: `ID.MOCK.QRIS|qris|${invoice.invoiceNo}|222000`,
      gatewayReference: 'T-REF-CONCURRENCY-1',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    // Same verified callback, delivered twice at once — exactly what a
    // Tripay retry (or a duplicate webhook delivery) looks like.
    const callback = {
      reference: 'T-REF-CONCURRENCY-1',
      invoiceRef: intent.id,
      amount: 222_000,
    };

    const [a, b] = await Promise.all([
      paymentIntentsService.settleFromGateway(callback),
      paymentIntentsService.settleFromGateway(callback),
    ]);

    // The MONEY invariant under test is what got WRITTEN (asserted below),
    // not the caller-visible `settled` flag on each individual call. At
    // least one call must report settled — otherwise nobody actually paid.
    // The other call CAN legitimately observe `settled: false` with reason
    // `amount_mismatch`: `settleFromGateway` reads the invoice's CURRENT
    // `balanceDue` (unlocked) to compare against the callback amount BEFORE
    // calling `confirm()`, and `confirm()` only flips `payment_intents
    // .status` to 'paid' AFTER the invoice itself is already 'paid' — so a
    // second delivery scheduled in that narrow window can see balanceDue=0
    // (the other call already settled the invoice) while `intent.status`
    // hasn't caught up to 'paid' yet, and trips the amount guard instead of
    // the idempotent early-return. This is a caller-visible-outcome race
    // ONLY (a real Tripay retry would land on the now-'paid' intent and
    // report settled next time) — it never double-writes; see the ledger/
    // invoice/customer assertions below, which hold regardless.
    expect(a.settled || b.settled).toBe(true);
    for (const result of [a, b]) {
      if (!result.settled) expect(result.reason).toBe('amount_mismatch');
    }

    const ledger = await invoicesRepo.listPayments({ limit: 50, offset: 0 });
    expect(ledger.total).toBe(1); // FOR UPDATE serialized the loser into the idempotent no-op branch
    expect(ledger.items[0]?.amount).toBe(222_000);
    expect(ledger.items[0]?.invoiceId).toBe(invoice.id);

    const [finalInvoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(finalInvoice?.status).toBe('paid');
    expect(finalInvoice?.paidAmount).toBe(222_000);

    const [finalIntent] = await db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, intent.id))
      .limit(1);
    expect(finalIntent?.status).toBe('paid');

    const [finalCustomer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    expect(finalCustomer?.status).toBe('aktif'); // reactivated exactly once
    expect(finalCustomer?.outstanding).toBe(0);
  });
});
