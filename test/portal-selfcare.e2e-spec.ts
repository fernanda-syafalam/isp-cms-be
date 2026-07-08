import fastifyCookie from '@fastify/cookie';
import { VersioningType } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { DrizzleService } from '../src/infrastructure/database/drizzle.service';
import type { AcsDevice } from '../src/infrastructure/database/schema/acs.schema';
import type { Announcement } from '../src/infrastructure/database/schema/announcements.schema';
import type { User } from '../src/infrastructure/database/schema/users.schema';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { AcsRepository } from '../src/modules/acs/acs.repository';
import { AnnouncementsRepository } from '../src/modules/announcements/announcements.repository';
import { CustomersRepository } from '../src/modules/customers/customers.repository';
import { CustomersService } from '../src/modules/customers/customers.service';
import type { CustomerResponse } from '../src/modules/customers/dto/customer-response.dto';
import { UsersRepository } from '../src/modules/users/users.repository';

/**
 * P3.C.4 portal self-care: usage/quota, WiFi SSID read+change, active
 * announcements. Every endpoint is scoped to the resolved session customer —
 * this suite asserts a customer JWT sees only its own data and a
 * non-customer role is rejected outright (class-level @Roles('customer')).
 */
describe('Portal self-care (e2e)', () => {
  let app: NestFastifyApplication;

  // Fixture ids must be RFC-4122-shaped v4 UUIDs — the response schemas
  // declare `z.uuid()`, which the now-live ZodSerializerInterceptor
  // actually parses (it requires the version/variant nibbles `4`/`8-b`,
  // not just hex characters).
  const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
  const CUSTOMER_FULL_NAME = 'Budi Santoso';
  const DEVICE_ID = '00000000-0000-4000-8000-00000000ad01';

  const actor: User = {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'budi@b.test',
    fullName: CUSTOMER_FULL_NAME,
    passwordHash: 'irrelevant',
    role: 'customer',
    resellerId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  };

  const CUSTOMER: CustomerResponse = {
    id: CUSTOMER_ID,
    customerNo: 'CUST-9001',
    fullName: CUSTOMER_FULL_NAME,
    phone: '0811',
    email: 'budi@b.test',
    address: 'Jl. Mawar',
    areaId: null,
    areaName: null,
    planId: '00000000-0000-4000-8000-0000000000e1',
    planName: 'Home 50',
    status: 'aktif',
    holdReason: null,
    outstanding: 0,
    billingAnchorDay: null,
    npwp: null,
    ktp: null,
    consentAt: null,
    resellerName: null,
    connection: null,
    joinedAt: '2026-01-01T00:00:00.000Z',
  };

  const DEVICE: AcsDevice = {
    id: DEVICE_ID,
    serial: 'ZTEG10000001',
    customerName: CUSTOMER_FULL_NAME,
    model: 'ZTE F670L',
    firmware: 'v2.3.0',
    ssid: 'RumahBudi',
    rxPowerDbm: -21.5,
    status: 'online',
    lastInform: new Date('2026-06-15T00:00:00.000Z'),
    createdAt: new Date('2026-06-15T00:00:00.000Z'),
    updatedAt: new Date('2026-06-15T00:00:00.000Z'),
  };

  const ANNOUNCEMENT: Announcement = {
    id: '00000000-0000-4000-8000-0000000000f1',
    title: 'Pemeliharaan jaringan terjadwal',
    body: 'Layanan dapat terputus sesaat.',
    severity: 'info',
    active: true,
    startsAt: null,
    endsAt: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
  };

  const fakeUsersRepo = {
    findById: vi.fn(async (id: string) => (id === actor.id ? actor : null)),
    findByEmail: vi.fn(async () => null),
    create: vi.fn(),
    listPage: vi.fn(),
    softDelete: vi.fn(),
  };

  // resolveForPortal is faked at the service layer — CustomerResponse (the
  // flat DTO) is a much lighter fixture than a raw Drizzle customers+plans
  // join row, and CustomersService is the seam PortalService actually calls.
  const fakeCustomersService = {
    resolveForPortal: vi.fn(async (session: { id: string }) =>
      session.id === actor.id ? CUSTOMER : Promise.reject(new Error('not this actor')),
    ),
  };

  // UsageService talks to CustomersRepository directly (not CustomersService),
  // so it needs its own fake — just the one method it calls.
  const fakeCustomersRepo = {
    findForUsage: vi.fn(async () => [
      { id: CUSTOMER_ID, fullName: CUSTOMER_FULL_NAME, planName: 'Home 50', planSpeedMbps: 50 },
    ]),
  };

  const fakeAcsRepo = {
    ensureSeeded: vi.fn(async () => undefined),
    findByCustomerName: vi.fn(async (name: string) =>
      name === CUSTOMER_FULL_NAME ? DEVICE : null,
    ),
    setWifi: vi.fn(async (id: string, ssid: string) =>
      id === DEVICE_ID ? { ...DEVICE, ssid } : null,
    ),
  };

  const fakeAnnouncementsRepo = {
    ensureSeeded: vi.fn(async () => undefined),
    listActive: vi.fn(async () => [ANNOUNCEMENT]),
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
      .overrideProvider(CustomersService)
      .useValue(fakeCustomersService)
      .overrideProvider(CustomersRepository)
      .useValue(fakeCustomersRepo)
      .overrideProvider(AcsRepository)
      .useValue(fakeAcsRepo)
      .overrideProvider(AnnouncementsRepository)
      .useValue(fakeAnnouncementsRepo)
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

  beforeEach(() => {
    fakeAcsRepo.setWifi.mockClear();
  });

  async function tokenFor(role: User['role']): Promise<string> {
    actor.role = role;
    const jwt = app.get(JwtService);
    return jwt.signAsync({ sub: actor.id, role });
  }

  describe('as the resolved customer', () => {
    it('GET /v1/portal/usage returns the caller`s own usage row', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/portal/usage',
        headers: { authorization: `Bearer ${await tokenFor('customer')}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.customerId).toBe(CUSTOMER_ID);
      expect(body.customerName).toBe(CUSTOMER_FULL_NAME);
      expect(body.planName).toBe('Home 50');
      expect(typeof body.quotaGb).toBe('number');
      expect(typeof body.usedGb).toBe('number');
      expect(typeof body.fupThrottled).toBe('boolean');
      expect(body.trend).toHaveLength(7);
    });

    it('GET /v1/portal/wifi returns the caller`s own device by fullName match', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/portal/wifi',
        headers: { authorization: `Bearer ${await tokenFor('customer')}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ serial: 'ZTEG10000001', model: 'ZTE F670L', ssid: 'RumahBudi' });
      expect(fakeAcsRepo.findByCustomerName).toHaveBeenCalledWith(CUSTOMER_FULL_NAME);
    });

    it('POST /v1/portal/wifi changes the SSID, persisted via the device resolved for the caller', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/portal/wifi',
        payload: { ssid: 'RumahBudi_5G', password: 'supersecret' },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('customer')}`,
        },
      });
      expect(res.statusCode).toBeLessThan(300);
      expect(res.json()).toEqual({ ok: true, ssid: 'RumahBudi_5G' });
      expect(fakeAcsRepo.setWifi).toHaveBeenCalledWith(DEVICE_ID, 'RumahBudi_5G');
    });

    it('POST /v1/portal/wifi 400s on an ssid over 32 chars', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/portal/wifi',
        payload: { ssid: 'x'.repeat(33), password: 'supersecret' },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('customer')}`,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(fakeAcsRepo.setWifi).not.toHaveBeenCalled();
    });

    it('POST /v1/portal/wifi 400s on a password shorter than 8 chars', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/portal/wifi',
        payload: { ssid: 'RumahBudi', password: 'short' },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('customer')}`,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(fakeAcsRepo.setWifi).not.toHaveBeenCalled();
    });

    it('GET /v1/portal/announcements returns the active feed', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/portal/announcements',
        headers: { authorization: `Bearer ${await tokenFor('customer')}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: ANNOUNCEMENT.id,
        title: ANNOUNCEMENT.title,
        severity: 'info',
        active: true,
      });
    });
  });

  describe('a non-customer role is rejected', () => {
    it('rejects a staff JWT with 403 on every portal self-care GET/POST', async () => {
      const token = await tokenFor('staff');
      const requests: Array<{
        method: 'GET' | 'POST';
        url: string;
        payload?: Record<string, string>;
      }> = [
        { method: 'GET', url: '/v1/portal/usage' },
        { method: 'GET', url: '/v1/portal/wifi' },
        { method: 'POST', url: '/v1/portal/wifi', payload: { ssid: 'X', password: 'supersecret' } },
        { method: 'GET', url: '/v1/portal/announcements' },
      ];
      for (const req of requests) {
        const res = await app.inject({
          method: req.method,
          url: req.url,
          payload: req.payload,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
        });
        expect({ url: req.url, status: res.statusCode }).toEqual({ url: req.url, status: 403 });
      }
    });
  });
});
