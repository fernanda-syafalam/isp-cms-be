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
import {
  type CustomerRow,
  CustomersRepository,
} from '../src/modules/customers/customers.repository';
import { InvoicesRepository } from '../src/modules/invoices/invoices.repository';
import { SecretEnforcementService } from '../src/modules/router-resources/secret-enforcement.service';
import { SlaCreditsRepository } from '../src/modules/sla-credits/sla-credits.repository';
import { TicketsRepository } from '../src/modules/tickets/tickets.repository';
import { UsersRepository } from '../src/modules/users/users.repository';

/**
 * MVP trim: routes whose UI is hidden carry @MvpDisabled() and must 404
 * for an authenticated admin, while isolate / change-plan stay reachable.
 */
describe('MVP-disabled endpoints (e2e)', () => {
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

  const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
  const customerRow: CustomerRow = {
    id: CUSTOMER_ID,
    customerNo: 'CUST-9001',
    fullName: 'Budi Santoso',
    phone: '081234567890',
    email: null,
    userId: null,
    address: 'Jl. Mawar 1',
    areaId: null,
    areaName: null,
    lat: null,
    lng: null,
    odpId: null,
    planId: '00000000-0000-4000-8000-0000000000b1',
    status: 'aktif',
    holdReason: null,
    outstanding: 0,
    billingAnchorDay: null,
    npwp: null,
    ktp: null,
    consentAt: null,
    dataDeletionRequestedAt: null,
    resellerName: null,
    resellerId: null,
    connection: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    planName: 'Home 20',
  };
  const fakeSecrets = { applyDisabledForCustomer: vi.fn(async () => undefined) };

  const fakeCustomersRepo = {
    findById: vi.fn(async () => customerRow),
    setStatus: vi.fn(async () => ({ ...customerRow, status: 'isolir' as const })),
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
      .overrideProvider(SecretEnforcementService)
      .useValue(fakeSecrets)
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

  const ID = '00000000-0000-4000-8000-0000000000c1';
  const ROUTER = '00000000-0000-4000-8000-0000000000d1';

  const disabled: Array<[string, string]> = [
    ['POST', `/v1/customers/${ID}/suspend`],
    ['POST', `/v1/customers/${ID}/resume`],
    ['POST', `/v1/customers/${ID}/relocate`],
    ['POST', `/v1/customers/${ID}/onu/reboot`],
    ['POST', `/v1/customers/${ID}/onu/wifi`],
    ['GET', `/v1/routers/${ROUTER}/pools`],
    ['POST', `/v1/routers/${ROUTER}/pools`],
    ['DELETE', `/v1/routers/${ROUTER}/pools/${ID}`],
    ['GET', `/v1/routers/${ROUTER}/queues`],
    ['POST', `/v1/routers/${ROUTER}/queues`],
    ['PATCH', `/v1/routers/${ROUTER}/queues/${ID}`],
    ['DELETE', `/v1/routers/${ROUTER}/queues/${ID}`],
    ['GET', '/v1/payments/reconciliation'],
    ['GET', '/v1/analytics/reports'],
  ];

  // Compare with a genuinely unknown route (same method) so a 404 coming from a
  // service ("not found") cannot satisfy the test: only the guard's
  // "Cannot METHOD url" title (same shape Nest gives an unknown route) matches.
  it.each(disabled)('%s %s is 404 like an unknown route', async (method, url) => {
    const headers = await adminHeaders();
    const payload = method === 'GET' || method === 'DELETE' ? undefined : {};
    const res = await app.inject({ method: method as 'GET', url, headers, payload });
    expect(res.statusCode).toBe(404);
    expect(res.json().title).toBe(`Cannot ${method} ${url}`);

    const unknownUrl = `${url}/no-such-route`;
    const unknown = await app.inject({
      method: method as 'GET',
      url: unknownUrl,
      headers,
      payload,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().title).toBe(`Cannot ${method} ${unknownUrl}`);
    expect(unknown.json().type).toBe(res.json().type);
  });

  it('a disabled route without a token is still 401', async () => {
    const res = await app.inject({ method: 'POST', url: `/v1/customers/${ID}/suspend` });
    expect(res.statusCode).toBe(401);
  });

  it('POST isolate stays reachable: handler runs and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/customers/${ID}/isolate`,
      headers: await adminHeaders(),
    });
    expect(res.statusCode).toBe(201);
    expect(fakeCustomersRepo.setStatus).toHaveBeenCalledWith(ID, 'isolir', {
      holdReason: 'overdue',
    });
  });

  it('POST change-plan stays reachable: validation is reached (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/customers/${ID}/change-plan`,
      headers: await adminHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
