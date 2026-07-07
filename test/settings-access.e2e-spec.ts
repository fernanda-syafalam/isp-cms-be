import fastifyCookie from '@fastify/cookie';
import { VersioningType } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { DrizzleService } from '../src/infrastructure/database/drizzle.service';
import type { AppSettings } from '../src/infrastructure/database/schema/settings.schema';
import type { User } from '../src/infrastructure/database/schema/users.schema';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { SettingsRepository } from '../src/modules/settings/settings.repository';
import { UsersRepository } from '../src/modules/users/users.repository';

/**
 * SEC-3 regression: `GET /v1/settings` carries the full config blob
 * (including the billing-policy section: late fee, due days, isolir grace
 * days) and must be admin-only. `GET /v1/settings/public` carries only the
 * invoice-needed subset (company identity + tax fields) and must stay
 * reachable by any authenticated role, including `customer`.
 */
describe('Settings role-scoped exposure (e2e)', () => {
  let app: NestFastifyApplication;

  const actor: User = {
    id: '00000000-0000-0000-0000-000000000002',
    email: 'actor@settings.test',
    fullName: 'Actor',
    passwordHash: 'irrelevant',
    role: 'customer',
    resellerId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  };

  const row: AppSettings = {
    id: '00000000-0000-0000-0000-00000000a201',
    singleton: true,
    companyName: 'Jepara Net',
    companyAddress: 'Jl. Pemuda No. 12, Jepara, Jawa Tengah',
    companyPhone: '0291-591234',
    companyEmail: 'billing@jeparanet.id',
    billingLateFeeIdr: 25_000,
    billingDueDays: 10,
    billingIsolirGraceDays: 3,
    taxPkp: true,
    taxNpwp: '01.234.567.8-901.000',
    taxPpnRate: 0.11,
    updatedAt: new Date('2026-06-15T00:00:00.000Z'),
  };

  const fakeUsersRepo = {
    findById: vi.fn(async (id: string) => (id === actor.id ? actor : null)),
    findByEmail: vi.fn(async () => null),
    create: vi.fn(),
    listPage: vi.fn(),
    softDelete: vi.fn(),
  };

  const fakeSettingsRepo = {
    getOrCreate: vi.fn(async () => row),
    update: vi.fn(),
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
      .overrideProvider(SettingsRepository)
      .useValue(fakeSettingsRepo)
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

  it('serves the full blob to admin on GET /v1/settings', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/settings',
      headers: { authorization: `Bearer ${await tokenFor('admin')}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      company: {
        name: 'Jepara Net',
        address: 'Jl. Pemuda No. 12, Jepara, Jawa Tengah',
        phone: '0291-591234',
        email: 'billing@jeparanet.id',
      },
      billing: { lateFeeIdr: 25_000, dueDays: 10, isolirGraceDays: 3 },
      tax: { pkp: true, npwp: '01.234.567.8-901.000', ppnRate: 0.11 },
    });
  });

  it('rejects staff and customer with 403 on GET /v1/settings', async () => {
    for (const role of ['staff', 'customer'] as const) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/settings',
        headers: { authorization: `Bearer ${await tokenFor(role)}` },
      });
      expect({ role, status: res.statusCode }).toEqual({ role, status: 403 });
    }
  });

  it('serves only the invoice-needed subset on GET /v1/settings/public, for every role', async () => {
    for (const role of ['admin', 'staff', 'customer'] as const) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/settings/public',
        headers: { authorization: `Bearer ${await tokenFor(role)}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({
        company: {
          name: 'Jepara Net',
          address: 'Jl. Pemuda No. 12, Jepara, Jawa Tengah',
          phone: '0291-591234',
          email: 'billing@jeparanet.id',
        },
        tax: { pkp: true, npwp: '01.234.567.8-901.000', ppnRate: 0.11 },
      });
      // The admin-only billing section must never leak into the subset.
      expect(body).not.toHaveProperty('billing');
    }
  });
});
