import { createHmac } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { DrizzleService } from '../src/infrastructure/database/drizzle.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { PaymentIntentsService } from '../src/modules/invoices/payment-intents.service';

const TRIPAY_PRIVATE_KEY = 'e2e-test-tripay-private-key';

/**
 * HTTP-boundary + REAL crypto safety net (ADR-0016) for
 * `POST /v1/webhooks/tripay`: `PaymentGateway` is left WIRED to the real
 * `TripayPaymentGateway` (forced live via env — see beforeAll) so the HMAC
 * verification actually runs; only `PaymentIntentsService.settleFromGateway`
 * is faked, since its own business logic (idempotency, amount/reference
 * checks) is already covered by `payment-intents.service.spec.ts`. The point
 * of this suite is "does an invalid signature actually get rejected, and
 * does a valid one actually reach settlement" — the same division of labour
 * `test/money.e2e-spec.ts` uses for the rest of the money-mutating routes.
 */
describe('POST /v1/webhooks/tripay (e2e)', () => {
  let app: NestFastifyApplication;
  let originalEnv: Record<string, string | undefined>;

  const fakePaymentIntentsService = {
    settleFromGateway: vi.fn(
      async (): Promise<
        | { settled: true }
        | { settled: false; reason: 'unknown_intent' | 'reference_mismatch' | 'amount_mismatch' }
      > => ({ settled: true }),
    ),
    markGatewayNonSettlement: vi.fn(async () => undefined),
  };

  function sign(body: Buffer): string {
    return createHmac('sha256', TRIPAY_PRIVATE_KEY).update(body).digest('hex');
  }

  function payload(over: Record<string, unknown> = {}): Buffer {
    return Buffer.from(
      JSON.stringify({
        reference: 'T1234567890',
        merchant_ref: '00000000-0000-4000-8000-0000000000f1',
        status: 'PAID',
        total_amount: 116_000,
        ...over,
      }),
    );
  }

  beforeAll(async () => {
    originalEnv = {
      PAYMENT_MODE: process.env.PAYMENT_MODE,
      TRIPAY_API_KEY: process.env.TRIPAY_API_KEY,
      TRIPAY_PRIVATE_KEY: process.env.TRIPAY_PRIVATE_KEY,
      TRIPAY_MERCHANT_CODE: process.env.TRIPAY_MERCHANT_CODE,
      TRIPAY_BASE_URL: process.env.TRIPAY_BASE_URL,
    };
    process.env.PAYMENT_MODE = 'live';
    process.env.TRIPAY_API_KEY = 'e2e-test-api-key';
    process.env.TRIPAY_PRIVATE_KEY = TRIPAY_PRIVATE_KEY;
    process.env.TRIPAY_MERCHANT_CODE = 'T0001';
    process.env.TRIPAY_BASE_URL = 'https://tripay.test/api-sandbox';

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
      .overrideProvider(PaymentIntentsService)
      .useValue(fakePaymentIntentsService)
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      // Required for the controller's `req.rawBody` — same option main.ts
      // passes to NestFactory.create (ADR-0016).
      rawBody: true,
    });
    await app.register(fastifyCookie as unknown as Parameters<typeof app.register>[0]);
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterEach(() => {
    fakePaymentIntentsService.settleFromGateway.mockClear();
    fakePaymentIntentsService.markGatewayNonSettlement.mockClear();
  });

  it('valid signature + paid status: 200 and settlement delegated to settleFromGateway', async () => {
    const body = payload();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/tripay',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-callback-signature': sign(body),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(fakePaymentIntentsService.settleFromGateway).toHaveBeenCalledWith({
      reference: 'T1234567890',
      invoiceRef: '00000000-0000-4000-8000-0000000000f1',
      status: 'paid',
      amount: 116_000,
    });
  });

  it('valid signature + non-paid status (expired/failed): 200, settlement NOT called, intent housekeeping (L3) delegated instead', async () => {
    const body = payload({ status: 'EXPIRED' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/tripay',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-callback-signature': sign(body),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(fakePaymentIntentsService.settleFromGateway).not.toHaveBeenCalled();
    expect(fakePaymentIntentsService.markGatewayNonSettlement).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-0000000000f1',
    );
  });

  // M1: a DETERMINISTIC non-settle reason (amount mismatch, reference
  // mismatch, unknown intent) must still 200 — retrying the same callback
  // can never turn a permanent condition into a success, so a non-2xx here
  // would only produce a Tripay retry storm. settleFromGateway itself
  // already logged the audit:true reconciliation alert (unit-tested in
  // payment-intents.service.spec.ts) — this only proves the HTTP layer
  // does not translate its `settled:false` result into a retry-me status.
  it('valid signature + paid status but settleFromGateway reports a deterministic non-settle (e.g. amount mismatch): still 200, never a retry-triggering status', async () => {
    fakePaymentIntentsService.settleFromGateway.mockResolvedValueOnce({
      settled: false,
      reason: 'amount_mismatch',
    });
    const body = payload();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/tripay',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-callback-signature': sign(body),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(fakePaymentIntentsService.settleFromGateway).toHaveBeenCalledTimes(1);
  });

  it('bad signature: 401, settlement NOT called (never settled)', async () => {
    const body = payload();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/tripay',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-callback-signature': 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      },
    });

    expect(res.statusCode).toBe(401);
    expect(fakePaymentIntentsService.settleFromGateway).not.toHaveBeenCalled();
  });

  it('missing signature header: 401, settlement NOT called', async () => {
    const body = payload();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/tripay',
      payload: body,
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(401);
    expect(fakePaymentIntentsService.settleFromGateway).not.toHaveBeenCalled();
  });

  it('no Authorization header is required at all (route is @Public)', async () => {
    const body = payload();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/tripay',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-callback-signature': sign(body),
        // Deliberately no `authorization` header — proves JwtAuthGuard's
        // default-deny does not block this route (it's @Public()).
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it("duplicate delivery of the same callback: both requests 200, settleFromGateway called twice (idempotency is settleFromGateway/confirm()'s own job — see payment-intents.service.spec.ts)", async () => {
    const body = payload();
    const headers = { 'content-type': 'application/json', 'x-callback-signature': sign(body) };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/tripay',
      payload: body,
      headers,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/tripay',
      payload: body,
      headers,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Both calls DO reach the service — that's correct (Tripay is allowed
    // to redeliver); settleFromGateway itself is what must no-op on the
    // second call, and that behaviour is unit-tested where the real
    // idempotency logic lives, not re-asserted against a fake here.
    expect(fakePaymentIntentsService.settleFromGateway).toHaveBeenCalledTimes(2);
  });
});
