import fastifyCookie from '@fastify/cookie';
import { VersioningType } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { DrizzleService } from '../src/infrastructure/database/drizzle.service';
import type { User } from '../src/infrastructure/database/schema/users.schema';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { CustomersService } from '../src/modules/customers/customers.service';
import { BillingAutomationService } from '../src/modules/invoices/billing-automation.service';
import type {
  IsolirResult,
  RemindResult,
  SchedulerRunResult,
} from '../src/modules/invoices/dto/billing-automation.dto';
import type { BillingRunResult } from '../src/modules/invoices/dto/billing-run-result.dto';
import type { InvoiceResponse } from '../src/modules/invoices/dto/invoice-response.dto';
import type { PaymentIntentResponse } from '../src/modules/invoices/dto/payment-intent-response.dto';
import { InvoicesService } from '../src/modules/invoices/invoices.service';
import { PaymentIntentsService } from '../src/modules/invoices/payment-intents.service';
import { UsersRepository } from '../src/modules/users/users.repository';

/**
 * HTTP-boundary safety net (audit finding TEST-C1) for the money-mutating
 * routes: invoice settlement, billing automation, gateway payment intents
 * (staff + portal-scoped). Every dependency below the controller is faked
 * at the SERVICE seam (not the repository) — the point of this suite is
 * "does the route bind params, validate the DTO, enforce @Roles, and
 * serialize the response correctly", not the business logic underneath
 * (already covered by *.service.spec.ts / *.repository.int-spec.ts).
 */
describe('Money + billing mutating endpoints (e2e)', () => {
  let app: NestFastifyApplication;

  // Fixture ids must be RFC-4122-shaped v4 UUIDs — the response schemas
  // declare `z.uuid()`, which the now-live ZodSerializerInterceptor
  // actually parses (it requires the version/variant nibbles `4`/`8-b`,
  // not just hex characters; the all-zero id is otherwise special-cased
  // and would ALSO fail without them).
  const INVOICE_ID = '00000000-0000-4000-8000-0000000000e1';
  const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
  const INTENT_ID = '00000000-0000-4000-8000-0000000000f1';

  const actor: User = {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'actor@b.test',
    fullName: 'Actor',
    passwordHash: 'irrelevant',
    role: 'staff',
    resellerId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  };

  const fakeUsersRepo = {
    findById: vi.fn(async (id: string) => (id === actor.id ? actor : null)),
    findByEmail: vi.fn(async () => null),
    create: vi.fn(),
    listPage: vi.fn(),
    softDelete: vi.fn(),
  };

  const PAID_INVOICE: InvoiceResponse = {
    id: INVOICE_ID,
    invoiceNo: 'INV-2026-000123',
    customerId: CUSTOMER_ID,
    customerName: 'Budi Santoso',
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    amount: 200000,
    lateFee: 0,
    taxAmount: 22000,
    discountAmount: 0,
    paidAmount: 222000,
    balanceDue: 0,
    taxInvoiceNo: null,
    status: 'paid',
    dueDate: '2026-07-10',
    paidAt: '2026-07-08T00:00:00.000Z',
    lastRemindedAt: null,
    type: 'regular',
    note: null,
  };

  const BILLING_RUN_RESULT: BillingRunResult = { period: '2026-07', created: 3 };
  const ISOLIR_RESULT: IsolirResult = { markedOverdue: 2, isolated: 1 };
  const REMIND_RESULT: RemindResult = { reminded: 5, channel: 'whatsapp' };
  const SCHEDULER_RUN_RESULT: SchedulerRunResult = {
    period: '2026-07',
    created: 3,
    remindedUpcoming: 2,
    remindedOverdue: 1,
    isolated: 1,
  };

  const PENDING_INTENT: PaymentIntentResponse = {
    id: INTENT_ID,
    invoiceId: INVOICE_ID,
    invoiceNo: 'INV-2026-000123',
    customerName: 'Budi Santoso',
    amount: 222000,
    channel: 'qris',
    status: 'pending',
    vaNumber: null,
    qrPayload: 'ID.MOCK.QRIS|qris|INV-2026-000123|222000',
    createdAt: '2026-07-08T00:00:00.000Z',
    expiresAt: '2026-07-09T00:00:00.000Z',
    paidAt: null,
  };

  const PAID_INTENT: PaymentIntentResponse = {
    ...PENDING_INTENT,
    status: 'paid',
    paidAt: '2026-07-08T01:00:00.000Z',
  };

  const fakeInvoicesService = {
    pay: vi.fn(async (id: string) => (id === INVOICE_ID ? PAID_INVOICE : { ...PAID_INVOICE, id })),
    run: vi.fn(async () => BILLING_RUN_RESULT),
  };

  const fakeBillingAutomationService = {
    isolirOverdue: vi.fn(async () => ISOLIR_RESULT),
    remind: vi.fn(async () => REMIND_RESULT),
    schedulerPreview: vi.fn(),
    schedulerRun: vi.fn(async () => SCHEDULER_RUN_RESULT),
  };

  const fakePaymentIntentsService = {
    create: vi.fn(async () => PENDING_INTENT),
    confirm: vi.fn(async () => PAID_INTENT),
    createForCustomer: vi.fn(async () => PENDING_INTENT),
    findForCustomer: vi.fn(async () => PENDING_INTENT),
    pendingForCustomer: vi.fn(async () => []),
    expireStale: vi.fn(async () => ({ expired: 0 })),
  };

  // PortalController resolves the caller's own customer through
  // CustomersService.resolveForPortal — faked at that seam (same pattern
  // as portal-selfcare.e2e-spec.ts) so the pay-intent tests below never
  // touch a real repository.
  const fakeCustomersService = {
    resolveForPortal: vi.fn(async () => ({ id: CUSTOMER_ID, fullName: 'Budi Santoso' })),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DrizzleService)
      .useValue({
        ping: async () => true,
        onModuleInit: () => Promise.resolve(),
        onModuleDestroy: () => Promise.resolve(),
      })
      .overrideProvider(RedisService)
      .useValue({
        client: {
          call: async () => null,
          get: async () => null,
          set: async () => 'OK',
          getdel: async () => null,
          del: async () => 0,
        },
        ping: async () => true,
        onModuleInit: () => Promise.resolve(),
        onModuleDestroy: () => Promise.resolve(),
      })
      .overrideProvider(UsersRepository)
      .useValue(fakeUsersRepo)
      .overrideProvider(InvoicesService)
      .useValue(fakeInvoicesService)
      .overrideProvider(BillingAutomationService)
      .useValue(fakeBillingAutomationService)
      .overrideProvider(PaymentIntentsService)
      .useValue(fakePaymentIntentsService)
      .overrideProvider(CustomersService)
      .useValue(fakeCustomersService)
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as unknown as Parameters<typeof app.register>[0]);
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function tokenFor(role: User['role']): Promise<string> {
    actor.role = role;
    const jwt = app.get(JwtService);
    return jwt.signAsync({ sub: actor.id, role });
  }

  describe('POST /v1/invoices/:id/pay', () => {
    it('staff: 201 + full response shape, status flips to paid', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/invoices/${INVOICE_ID}/pay`,
        payload: { method: 'transfer' },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('staff')}`,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(PAID_INVOICE);
      expect(fakeInvoicesService.pay).toHaveBeenCalledWith(INVOICE_ID, { method: 'transfer' });
    });

    it('customer: 403 (role without access, guard runs before the service)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/invoices/${INVOICE_ID}/pay`,
        payload: { method: 'transfer' },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('customer')}`,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400s on a malformed body (ZodValidationPipe wiring)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/invoices/${INVOICE_ID}/pay`,
        payload: { method: 'bitcoin' },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('staff')}`,
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('Billing automation (POST /v1/billing/*)', () => {
    it('run: 201 + shape, staff', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/billing/run',
        headers: { authorization: `Bearer ${await tokenFor('staff')}` },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(BILLING_RUN_RESULT);
    });

    it('isolir-overdue: 200 + shape, staff', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/billing/isolir-overdue',
        headers: { authorization: `Bearer ${await tokenFor('staff')}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(ISOLIR_RESULT);
    });

    it('remind: 200 + shape, staff', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/billing/remind',
        payload: {},
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('staff')}`,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(REMIND_RESULT);
    });

    it('scheduler/run: 200 + shape, staff', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/billing/scheduler/run',
        headers: { authorization: `Bearer ${await tokenFor('staff')}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(SCHEDULER_RUN_RESULT);
    });

    it('rejects customer and mitra with 403 on every billing mutation', async () => {
      const endpoints = [
        '/v1/billing/run',
        '/v1/billing/isolir-overdue',
        '/v1/billing/scheduler/run',
      ];
      for (const role of ['customer', 'mitra'] as const) {
        const token = await tokenFor(role);
        for (const url of endpoints) {
          const res = await app.inject({
            method: 'POST',
            url,
            headers: { authorization: `Bearer ${token}` },
          });
          expect({ role, url, status: res.statusCode }).toEqual({ role, url, status: 403 });
        }
        const remind = await app.inject({
          method: 'POST',
          url: '/v1/billing/remind',
          payload: {},
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        });
        expect({ role, status: remind.statusCode }).toEqual({ role, status: 403 });
      }
    });
  });

  describe('POST /v1/payments/intent (+ confirm) — staff/admin gateway path', () => {
    it('create: 201 + shape, staff', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments/intent',
        payload: { invoiceId: INVOICE_ID, channel: 'qris' },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('staff')}`,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(PENDING_INTENT);
    });

    it('confirm: 201 + shape (paid), staff', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/payments/intent/${INTENT_ID}/confirm`,
        headers: { authorization: `Bearer ${await tokenFor('staff')}` },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(PAID_INTENT);
    });

    it('customer: 403 on both routes', async () => {
      const token = await tokenFor('customer');
      const create = await app.inject({
        method: 'POST',
        url: '/v1/payments/intent',
        payload: { invoiceId: INVOICE_ID, channel: 'qris' },
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      });
      expect(create.statusCode).toBe(403);

      const confirm = await app.inject({
        method: 'POST',
        url: `/v1/payments/intent/${INTENT_ID}/confirm`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(confirm.statusCode).toBe(403);
    });
  });

  describe('POST /v1/portal/pay-intent (+ GET status) — customer-scoped gateway path', () => {
    // SECURITY FIX (SEC-H1, was a latent-Critical free-internet hole):
    // `POST /v1/portal/pay-intent/:id/confirm` let a customer self-settle
    // their own invoice with zero payment verification — it called straight
    // through to `payment-intents.service.confirm` (mark paid + reactivate)
    // with no gateway involved. That route is now REMOVED; the customer may
    // only create an intent and poll its status (`GET .../pay-intent/:id`).
    // Settlement survives only on the staff/admin route above (or, P4
    // future, a signed gateway webhook) — see `payment-intents.service.ts`
    // `confirm()` / `findForCustomer()`.
    it('createPayIntent: 201 + shape, customer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/portal/pay-intent',
        payload: { invoiceId: INVOICE_ID, channel: 'qris' },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('customer')}`,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(PENDING_INTENT);
    });

    it('GET pay-intent/:id: 200 + shape (status poll only), customer', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/portal/pay-intent/${INTENT_ID}`,
        headers: { authorization: `Bearer ${await tokenFor('customer')}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(PENDING_INTENT);
      expect(fakePaymentIntentsService.findForCustomer).toHaveBeenCalledWith(
        CUSTOMER_ID,
        INTENT_ID,
      );
    });

    it('SEC-H1 regression: the self-settle route is gone — a customer can no longer confirm/pay their own intent', async () => {
      // `confirm` is shared with the staff/admin describe block above (no
      // per-test mock reset in this suite), so assert the call count is
      // unchanged by THIS request rather than "never called".
      const callsBefore = fakePaymentIntentsService.confirm.mock.calls.length;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/portal/pay-intent/${INTENT_ID}/confirm`,
        headers: { authorization: `Bearer ${await tokenFor('customer')}` },
      });
      // No handler matches this path anymore (JwtAuthGuard/RolesGuard never
      // even run) — Fastify/Nest answers 404, not 403. Either way the
      // invoice-settlement service is never invoked by a customer.
      expect(res.statusCode).toBe(404);
      expect(fakePaymentIntentsService.confirm.mock.calls.length).toBe(callsBefore);
    });

    it('staff: 403 on the portal-scoped create + poll routes (customer-only surface)', async () => {
      const token = await tokenFor('staff');
      const create = await app.inject({
        method: 'POST',
        url: '/v1/portal/pay-intent',
        payload: { invoiceId: INVOICE_ID, channel: 'qris' },
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      });
      expect(create.statusCode).toBe(403);

      const poll = await app.inject({
        method: 'GET',
        url: `/v1/portal/pay-intent/${INTENT_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(poll.statusCode).toBe(403);
    });
  });
});
