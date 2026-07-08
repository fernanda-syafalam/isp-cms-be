import fastifyCookie from '@fastify/cookie';
import { VersioningType } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { DrizzleService } from '../src/infrastructure/database/drizzle.service';
import type {
  Reseller,
  ResellerPayout,
} from '../src/infrastructure/database/schema/resellers.schema';
import type { User } from '../src/infrastructure/database/schema/users.schema';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { ResellersRepository } from '../src/modules/resellers/resellers.repository';
import { UsersRepository } from '../src/modules/users/users.repository';

/**
 * HTTP-boundary safety net (audit finding TEST-C1) for reseller creation +
 * the payout state machine (requested -> approved/rejected -> paid), plus
 * TEST-H3: the mitra-ownership IDOR guard on the payout surface.
 *
 * Only ResellersRepository is faked (not ResellersService) — unlike the
 * other money e2e suites, the ownership check under test here
 * (`assertResellerAccess`) lives IN ResellersService, so the service must
 * stay real for the mitra-IDOR assertion to mean anything.
 */
describe('Resellers + payout lifecycle (e2e)', () => {
  let app: NestFastifyApplication;

  // v4-shaped (not just hex) — these land in ResellerResponse/PayoutResponse,
  // which the now-live ZodSerializerInterceptor validates against
  // `z.uuid()` (RFC-4122 version/variant nibbles required).
  const RESELLER_ID = '00000000-0000-4000-8000-0000000000d1';
  const FOREIGN_RESELLER_ID = '00000000-0000-4000-8000-0000000000d2';
  const PAYOUT_ID = '00000000-0000-4000-8000-0000000000e1';

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

  const RESELLER_ROW: Reseller = {
    id: RESELLER_ID,
    name: 'Loket Andi',
    area: 'Jepara',
    balance: 100000,
    commissionPct: 0.05,
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  const PAYOUT_ROW: ResellerPayout = {
    id: PAYOUT_ID,
    resellerId: RESELLER_ID,
    amount: 50000,
    status: 'requested',
    note: 'payout mingguan',
    requestedBy: actor.id,
    decidedBy: null,
    ledgerEntryId: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    decidedAt: null,
  };

  const fakeResellersRepo = {
    list: vi.fn(),
    create: vi.fn(async () => RESELLER_ROW),
    findById: vi.fn(async (id: string) => (id === RESELLER_ID ? RESELLER_ROW : null)),
    update: vi.fn(),
    listLedger: vi.fn(),
    addLedgerEntry: vi.fn(),
    listPayouts: vi.fn(async () => ({ items: [PAYOUT_ROW], total: 1 })),
    createPayout: vi.fn(async () => PAYOUT_ROW),
    findPayoutById: vi.fn(async (id: string) => (id === PAYOUT_ID ? PAYOUT_ROW : null)),
    approvePayout: vi.fn(async (_payoutId: string, actorId: string | null) => ({
      ...PAYOUT_ROW,
      status: 'approved' as const,
      decidedBy: actorId,
      decidedAt: new Date('2026-07-02T00:00:00Z'),
    })),
    rejectPayout: vi.fn(async (_payoutId: string, actorId: string | null) => ({
      ...PAYOUT_ROW,
      status: 'rejected' as const,
      decidedBy: actorId,
      decidedAt: new Date('2026-07-02T00:00:00Z'),
    })),
    disbursePayout: vi.fn(async () => ({
      ...PAYOUT_ROW,
      status: 'paid' as const,
      ledgerEntryId: '00000000-0000-4000-8000-0000000000f1',
      decidedAt: new Date('2026-07-02T00:00:00Z'),
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
      .overrideProvider(ResellersRepository)
      .useValue(fakeResellersRepo)
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

  describe('POST /v1/resellers', () => {
    it('staff: 201 + shape', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/resellers',
        payload: { name: 'Loket Andi', area: 'Jepara', commissionPct: 0.05 },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('staff')}`,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        id: RESELLER_ID,
        name: 'Loket Andi',
        area: 'Jepara',
        balance: 100000,
        commissionPct: 0.05,
        customerCount: 0,
        status: 'active',
      });
    });

    it('mitra: 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/resellers',
        payload: { name: 'Loket Andi', area: 'Jepara' },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('mitra')}`,
        },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Payout lifecycle', () => {
    it('POST /v1/resellers/:id/payouts — staff: 201 + shape (requested)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${RESELLER_ID}/payouts`,
        payload: { amount: 50000, note: 'payout mingguan' },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('staff')}`,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        id: PAYOUT_ID,
        resellerId: RESELLER_ID,
        amount: 50000,
        status: 'requested',
      });
    });

    it('POST .../payouts — mitra: 403 (request is admin/staff only, not a mitra self-service action)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${RESELLER_ID}/payouts`,
        payload: { amount: 50000 },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('mitra')}`,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('POST .../approve — staff: 201 + shape (approved)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${RESELLER_ID}/payouts/${PAYOUT_ID}/approve`,
        headers: { authorization: `Bearer ${await tokenFor('staff')}` },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: PAYOUT_ID, status: 'approved', decidedBy: actor.id });
    });

    it('POST .../reject — staff: 201 + shape (rejected)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${RESELLER_ID}/payouts/${PAYOUT_ID}/reject`,
        headers: { authorization: `Bearer ${await tokenFor('staff')}` },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: PAYOUT_ID, status: 'rejected', decidedBy: actor.id });
    });

    it('POST .../disburse — staff: 201 + shape (paid, ledgerEntryId set)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${RESELLER_ID}/payouts/${PAYOUT_ID}/disburse`,
        headers: { authorization: `Bearer ${await tokenFor('staff')}` },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.status).toBe('paid');
      expect(typeof body.ledgerEntryId).toBe('string');
    });

    it('approve/reject/disburse: mitra 403 (decision is admin/staff only)', async () => {
      const token = await tokenFor('mitra');
      for (const action of ['approve', 'reject', 'disburse']) {
        const res = await app.inject({
          method: 'POST',
          url: `/v1/resellers/${RESELLER_ID}/payouts/${PAYOUT_ID}/${action}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect({ action, status: res.statusCode }).toEqual({ action, status: 403 });
      }
    });
  });

  // TEST-H3: mitra-ownership IDOR on the payout surface. requestPayout/
  // approve/reject/disburse are admin/staff-only (guard rejects a mitra
  // before the service's ownership check even runs, covered above); the
  // one payout route a mitra CAN reach is the read (list), which is where
  // ResellersService.assertResellerAccess enforces "own reseller only" —
  // a foreign resellerId must 404, never leak via 200/403.
  describe('GET /v1/resellers/:id/payouts — mitra ownership (TEST-H3 IDOR)', () => {
    it('mitra reading their OWN reseller payouts: 200 + shape', async () => {
      actor.resellerId = RESELLER_ID;
      const res = await app.inject({
        method: 'GET',
        url: `/v1/resellers/${RESELLER_ID}/payouts`,
        headers: { authorization: `Bearer ${await tokenFor('mitra')}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.items[0]).toMatchObject({ id: PAYOUT_ID, resellerId: RESELLER_ID });
    });

    it('mitra reading a FOREIGN reseller`s payouts: 404 (not 403, not 200 — IDOR guard)', async () => {
      // assertResellerAccess must reject BEFORE the repository is ever
      // touched — assert the call count doesn't move (`.not.toHaveBeenCalled()`
      // would be a false negative here, since the "own reseller" test above
      // already called it once in this same describe block).
      const callsBefore = fakeResellersRepo.listPayouts.mock.calls.length;
      actor.resellerId = FOREIGN_RESELLER_ID;
      const res = await app.inject({
        method: 'GET',
        url: `/v1/resellers/${RESELLER_ID}/payouts`,
        headers: { authorization: `Bearer ${await tokenFor('mitra')}` },
      });
      expect(res.statusCode).toBe(404);
      expect(fakeResellersRepo.listPayouts).toHaveBeenCalledTimes(callsBefore);
    });

    it('staff reading any reseller`s payouts: unaffected (200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/resellers/${RESELLER_ID}/payouts`,
        headers: { authorization: `Bearer ${await tokenFor('staff')}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
