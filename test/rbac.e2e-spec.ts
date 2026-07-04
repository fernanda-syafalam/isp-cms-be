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
import { UsersRepository } from '../src/modules/users/users.repository';

/**
 * Regression coverage for P0.2: the staff read surface is class-gated with
 * @Roles('admin','staff'), so a customer JWT must 403 on every staff list
 * endpoint. The RolesGuard runs before any repository is touched, so the
 * customer-403 assertions need no data fakes at all.
 */
describe('Staff read-surface gate (e2e)', () => {
  let app: NestFastifyApplication;

  // JwtStrategy resolves the caller from the users repository; the role
  // comes from this record, swapped per test.
  const actor: User = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'actor@b.test',
    fullName: 'Actor',
    passwordHash: 'irrelevant',
    role: 'customer',
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

  const fakeCustomersRepo = {
    list: vi.fn(async () => ({ items: [], total: 0 })),
    // resolveForPortal fails closed on a miss (P0.3) — returning null here
    // makes /v1/portal/me a deterministic 404 for the customer probe below.
    findByEmail: vi.fn(async () => null),
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
      .overrideProvider(CustomersRepository)
      .useValue(fakeCustomersRepo)
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

  // A representative sweep of the previously-ungated staff read surface —
  // one list endpoint per module class-gated in P0.2, including the
  // contracts IDOR (finding #2).
  const STAFF_GETS = [
    '/v1/customers',
    '/v1/customers/00000000-0000-0000-0000-0000000000c1/contract',
    '/v1/invoices',
    '/v1/payments',
    '/v1/tickets',
    '/v1/leads',
    '/v1/resellers',
    '/v1/vouchers',
    '/v1/routers',
    '/v1/routers/00000000-0000-0000-0000-0000000000r1/secrets',
    '/v1/inventory',
    '/v1/work-orders',
    '/v1/audit',
    '/v1/users',
    '/v1/accounting/journal',
    '/v1/monitoring/alerts',
  ];

  it('rejects a customer JWT with 403 on every staff GET', async () => {
    const token = await tokenFor('customer');
    for (const url of STAFF_GETS) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 403 });
    }
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/customers' });
    expect(res.statusCode).toBe(401);
  });

  it('still serves staff on a gated list endpoint', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${await tokenFor('staff')}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0 });
  });

  it('keeps the customer portal reachable for the customer role', async () => {
    // resolveForPortal fails closed with 404 for an unlinked login (P0.3) —
    // the point here is that the portal is NOT role-blocked (no 401/403).
    const res = await app.inject({
      method: 'GET',
      url: '/v1/portal/me',
      headers: { authorization: `Bearer ${await tokenFor('customer')}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
