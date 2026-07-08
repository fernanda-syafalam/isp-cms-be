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
import { WorkOrdersRepository } from '../src/modules/work-orders/work-orders.repository';

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
    id: '00000000-0000-4000-8000-000000000001',
    email: 'actor@b.test',
    fullName: 'Actor',
    passwordHash: 'irrelevant',
    role: 'customer',
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

  const emptyCustomerSummary = {
    total: 0,
    outstanding: 0,
    byStatus: { prospek: 0, instalasi: 0, aktif: 0, isolir: 0, berhenti: 0 },
  };

  // v4-shaped (not just hex) — `id`/`planId` land in CustomerResponse,
  // which the now-live ZodSerializerInterceptor validates against
  // `z.uuid()` (RFC-4122 version/variant nibbles required).
  const RESELLER_ID = '00000000-0000-4000-8000-0000000000d1';
  const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';

  // Full KYC-bearing row, used by the ADR-0010 amendment / ADR-0015 (SEC-4)
  // detail-route tests below — findById() itself decides (per the
  // { excludeKyc } opt passed by the service) whether to hand back the real
  // npwp/ktp or a real repo would substitute NULL; this fake stands in for
  // the repository so the KYC-safe projection is asserted at the SERVICE
  // layer here (the repository's own SQL-level NULL substitution is
  // covered in customers.repository.int-spec.ts against a real Postgres).
  const kycCustomerRow = {
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
    status: 'aktif' as const,
    holdReason: null,
    outstanding: 0,
    billingAnchorDay: null,
    npwp: '01.234.567.8-901.000',
    ktp: '3201xxxxxxxxxxxx',
    consentAt: null,
    dataDeletionRequestedAt: null,
    resellerName: 'Loket Andi',
    resellerId: RESELLER_ID,
    connection: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    planName: 'Home 20',
  };

  const fakeCustomersRepo = {
    list: vi.fn(async () => ({ items: [], total: 0, summary: emptyCustomerSummary })),
    // resolveForPortal fails closed on a miss (P0.3) — returning null here
    // makes /v1/portal/me a deterministic 404 for the customer probe below.
    findByEmail: vi.fn(async () => null),
    findByUserId: vi.fn(async () => null),
    findById: vi.fn(async (id: string, opts: { excludeKyc?: boolean } = {}) =>
      id === CUSTOMER_ID
        ? {
            ...kycCustomerRow,
            // Mirrors the real repository's SQL-level NULL substitution
            // (baseSelectKycSafe) so the mitra path is exercised the same
            // way it is at runtime — the value is never real for a
            // mitra caller, not merely stripped downstream.
            ...(opts.excludeKyc ? { npwp: null, ktp: null } : {}),
          }
        : null,
    ),
  };

  const fakeWorkOrdersRepo = {
    // `summary` is a required part of WorkOrderListResponseSchema (every
    // status key always zero-filled) — omitting it 500s now that the
    // response is actually parsed.
    list: vi.fn(async () => ({
      items: [],
      total: 0,
      summary: {
        total: 0,
        byStatus: { scheduled: 0, in_progress: 0, done: 0, cancelled: 0 },
      },
    })),
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
      .overrideProvider(WorkOrdersRepository)
      .useValue(fakeWorkOrdersRepo)
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
    expect(res.json()).toEqual({
      items: [],
      total: 0,
      summary: {
        total: 0,
        outstanding: 0,
        byStatus: { prospek: 0, instalasi: 0, aktif: 0, isolir: 0, berhenti: 0 },
      },
    });
  });

  // P1.2: teknisi is authorized for exactly its journey (network + tickets),
  // and nothing else.
  it('serves teknisi on its journey surface (work-orders list)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/work-orders',
      headers: { authorization: `Bearer ${await tokenFor('teknisi')}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('keeps teknisi out of the staff-only surface', async () => {
    const token = await tokenFor('teknisi');
    for (const url of ['/v1/customers', '/v1/invoices', '/v1/users', '/v1/resellers']) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 403 });
    }
  });

  it('keeps ticket creation staff-only while teknisi can read tickets', async () => {
    const token = await tokenFor('teknisi');
    const create = await app.inject({
      method: 'POST',
      url: '/v1/tickets',
      payload: { subject: 'x', customerName: 'y' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    expect(create.statusCode).toBe(403);
  });

  // P1.5: a mitra principal is scoped to their own reseller.
  it('scopes a mitra with no linked reseller to an empty customer list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: { authorization: `Bearer ${await tokenFor('mitra')}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [],
      total: 0,
      summary: {
        total: 0,
        outstanding: 0,
        byStatus: { prospek: 0, instalasi: 0, aktif: 0, isolir: 0, berhenti: 0 },
      },
    });
  });

  it('404s a mitra reading a reseller that is not theirs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/resellers/00000000-0000-0000-0000-0000000000e9',
      headers: { authorization: `Bearer ${await tokenFor('mitra')}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ADR-0010 amendment / ADR-0015 (SEC-4): mitra reads a customer's own
  // reseller detail record without KYC identity fields; scoping to another
  // reseller's customer still 404s.
  describe('mitra customer detail: KYC-safe projection + reseller scoping', () => {
    it('a mitra reading their own reseller customer gets it without npwp/ktp', async () => {
      actor.resellerId = RESELLER_ID;
      const res = await app.inject({
        method: 'GET',
        url: `/v1/customers/${CUSTOMER_ID}`,
        headers: { authorization: `Bearer ${await tokenFor('mitra')}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).not.toHaveProperty('npwp');
      expect(body).not.toHaveProperty('ktp');
      expect(body.id).toBe(CUSTOMER_ID);
      expect(body.resellerName).toBe('Loket Andi');
    });

    it('staff reading the same customer still gets npwp/ktp (unaffected)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/customers/${CUSTOMER_ID}`,
        headers: { authorization: `Bearer ${await tokenFor('staff')}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.npwp).toBe('01.234.567.8-901.000');
      expect(body.ktp).toBe('3201xxxxxxxxxxxx');
    });

    it('404s a mitra reading a customer that is not their reseller’s (scoping regression guard)', async () => {
      actor.resellerId = '00000000-0000-0000-0000-0000000000zz';
      const res = await app.inject({
        method: 'GET',
        url: `/v1/customers/${CUSTOMER_ID}`,
        headers: { authorization: `Bearer ${await tokenFor('mitra')}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('404s a mitra with no linked reseller reading any customer by id', async () => {
      actor.resellerId = null;
      const res = await app.inject({
        method: 'GET',
        url: `/v1/customers/${CUSTOMER_ID}`,
        headers: { authorization: `Bearer ${await tokenFor('mitra')}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  it('keeps mitra out of the staff-only surface', async () => {
    const token = await tokenFor('mitra');
    for (const url of ['/v1/invoices', '/v1/tickets', '/v1/users', '/v1/work-orders']) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 403 });
    }
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
