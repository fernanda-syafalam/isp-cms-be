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
import { UsersRepository } from '../src/modules/users/users.repository';
import type {
  BatchResult,
  VoucherResponse,
} from '../src/modules/vouchers/dto/voucher-response.dto';
import { VouchersService } from '../src/modules/vouchers/vouchers.service';

/**
 * HTTP-boundary safety net (audit finding TEST-C1) for the voucher batch
 * mint + redeem money paths. VouchersService is faked so this only proves
 * DTO validation, @Roles wiring, and ZodSerializerDto shape — the mint/
 * redeem business logic is covered by vouchers.service.spec.ts and
 * vouchers.repository.int-spec.ts.
 */
describe('Vouchers mutating endpoints (e2e)', () => {
  let app: NestFastifyApplication;

  // v4-shaped (not just hex) — `id` lands in VoucherResponse, which the
  // now-live ZodSerializerInterceptor validates against `z.uuid()`
  // (RFC-4122 version/variant nibbles required).
  const VOUCHER_ID = '00000000-0000-4000-8000-0000000000e1';

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

  const BATCH_RESULT: BatchResult = { batchId: 'BATCH-ABCD1234', created: 10 };

  const REDEEMED_VOUCHER: VoucherResponse = {
    id: VOUCHER_ID,
    code: 'VCH-000001',
    batchId: 'BATCH-ABCD1234',
    profile: 'hotspot-1jam',
    priceIdr: 5000,
    durationDays: 1,
    status: 'used',
    usedAt: '2026-07-08T00:00:00.000Z',
    usedBy: 'Budi Santoso',
    resellerId: null,
    resellerName: null,
    createdAt: '2026-07-01T00:00:00.000Z',
  };

  const fakeVouchersService = {
    list: vi.fn(),
    generateBatch: vi.fn(async () => BATCH_RESULT),
    redeem: vi.fn(async () => REDEEMED_VOUCHER),
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
      .overrideProvider(VouchersService)
      .useValue(fakeVouchersService)
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

  describe('POST /v1/vouchers/batch', () => {
    const PAYLOAD = { count: 10, profile: 'hotspot-1jam', priceIdr: 5000, durationDays: 1 };

    it('staff: 201 + shape', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/vouchers/batch',
        payload: PAYLOAD,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('staff')}`,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(BATCH_RESULT);
      expect(fakeVouchersService.generateBatch).toHaveBeenCalledWith(PAYLOAD);
    });

    it('customer: 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/vouchers/batch',
        payload: PAYLOAD,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('customer')}`,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400s over the 500-count cap (ZodValidationPipe wiring)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/vouchers/batch',
        payload: { ...PAYLOAD, count: 501 },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('staff')}`,
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /v1/vouchers/:id/redeem', () => {
    it('staff: 201 + shape', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/vouchers/${VOUCHER_ID}/redeem`,
        payload: { customerName: 'Budi Santoso' },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('staff')}`,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(REDEEMED_VOUCHER);
    });

    it('anonymous redemption (no body): still 201 + shape', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/vouchers/${VOUCHER_ID}/redeem`,
        headers: { authorization: `Bearer ${await tokenFor('staff')}` },
      });
      expect(res.statusCode).toBe(201);
      expect(fakeVouchersService.redeem).toHaveBeenCalledWith(VOUCHER_ID, {});
    });

    it('mitra: 403 (not a staff role)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/vouchers/${VOUCHER_ID}/redeem`,
        headers: { authorization: `Bearer ${await tokenFor('mitra')}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
