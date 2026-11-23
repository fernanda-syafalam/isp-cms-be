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
import { CustomersRepository } from '../src/modules/customers/customers.repository';
import { InvoicesRepository } from '../src/modules/invoices/invoices.repository';
import { SlaCreditsRepository } from '../src/modules/sla-credits/sla-credits.repository';
import { TicketsRepository } from '../src/modules/tickets/tickets.repository';
import { UsersRepository } from '../src/modules/users/users.repository';

/**
 * MVP trim: non-MVP modules are unregistered from AppModule, so their
 * routes must 404 even for an authenticated admin, while the kept
 * dashboard keeps answering without the removed device fields.
 */
describe('MVP-disabled routes (e2e)', () => {
  let app: NestFastifyApplication;

  const admin: User = {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'admin@b.test',
    fullName: 'Admin',
    passwordHash: 'irrelevant',
    role: 'admin',
    resellerId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  };

  const fakeUsersRepo = {
    findById: vi.fn(async (id: string) => (id === admin.id ? admin : null)),
    findByEmail: vi.fn(async () => null),
  };

  const fakeCustomersRepo = {
    countByStatus: vi.fn(async () => ({
      prospek: 0,
      instalasi: 0,
      aktif: 0,
      isolir: 0,
      berhenti: 0,
    })),
    countCreatedSince: vi.fn(async () => 0),
    countAtRisk: vi.fn(async () => 0),
    findActiveBillable: vi.fn(async () => []),
  };
  const fakeInvoicesRepo = {
    listUnpaid: vi.fn(async () => []),
    revenueByMonth: vi.fn(async () => []),
  };
  const fakeTicketsRepo = {
    countByStatus: vi.fn(async () => ({ open: 0, in_progress: 0, resolved: 0, breached: 0 })),
  };
  const fakeSlaCreditsRepo = { countPending: vi.fn(async () => 0) };

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
      .overrideProvider(CustomersRepository)
      .useValue(fakeCustomersRepo)
      .overrideProvider(InvoicesRepository)
      .useValue(fakeInvoicesRepo)
      .overrideProvider(TicketsRepository)
      .useValue(fakeTicketsRepo)
      .overrideProvider(SlaCreditsRepository)
      .useValue(fakeSlaCreditsRepo)
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

  async function adminHeaders(): Promise<{ authorization: string }> {
    const token = await app.get(JwtService).signAsync({ sub: admin.id, role: 'admin' });
    return { authorization: `Bearer ${token}` };
  }

  it.each([
    '/v1/vouchers',
    '/v1/portal/me',
    '/v1/branches',
    '/v1/leads',
    '/v1/devices',
    '/v1/resellers',
    '/v1/sla-credits',
  ])('GET %s is 404 (module unregistered)', async (url) => {
    const res = await app.inject({ method: 'GET', url, headers: await adminHeaders() });
    expect(res.statusCode).toBe(404);
  });

  // SEC-H1: customers may only poll charge status; settlement is Tripay webhook
  // or staff confirm only. Passes today because the portal is unregistered; when
  // it returns, move this to a portal e2e (customer token + confirm spy not called).
  it('POST /v1/portal/pay-intent/:id/confirm is 404 (SEC-H1)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/pay-intent/00000000-0000-4000-8000-0000000000f1/confirm',
      headers: await adminHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/analytics/dashboard is 200 without the device fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/analytics/dashboard',
      headers: await adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).not.toHaveProperty('devicesOnline');
    expect(body).not.toHaveProperty('devicesTotal');
    expect(body.commandCenter).not.toHaveProperty('odpFull');
    expect(body.commandCenter).not.toHaveProperty('slaCreditsPending');
  });
});
