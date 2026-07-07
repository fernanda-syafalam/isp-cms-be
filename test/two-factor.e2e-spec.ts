import fastifyCookie from '@fastify/cookie';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { DrizzleService } from '../src/infrastructure/database/drizzle.service';
import type { User } from '../src/infrastructure/database/schema/users.schema';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { SecurityRepository } from '../src/modules/security/security.repository';
import { UsersRepository } from '../src/modules/users/users.repository';

const PASSWORD = 'correct-horse-battery-staple';

interface FakeSecurityRow {
  userId: string;
  twoFactorEnabled: boolean;
  twoFactorSecret: string | null;
}

/**
 * Full-pipeline (controller → guard → DTO → service → "repository") e2e
 * coverage for real TOTP 2FA: enroll → confirm → login challenge →
 * disable, without a real Postgres. `SecurityRepository` is overridden
 * with an in-memory fake that behaves like the real one (state actually
 * persists across calls within the test) so the flow is exercised for
 * real, not just mocked at the service layer (see security.service.spec.ts
 * for the service-level unit tests, and auth.service.spec.ts for the
 * login-challenge unit tests).
 */
describe('Two-factor authentication (e2e)', () => {
  let app: NestFastifyApplication;
  let storedUser: User;
  const securityState = new Map<string, FakeSecurityRow>();

  beforeAll(async () => {
    storedUser = {
      id: '00000000-0000-0000-0000-000000000002',
      email: 'staff@b.test',
      fullName: 'Staff Member',
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      role: 'staff',
      resellerId: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      deletedAt: null,
    };

    const fakeUsersRepo = {
      findById: vi.fn(async (id: string) => (id === storedUser.id ? storedUser : null)),
      findByEmail: vi.fn(async (email: string) => (email === storedUser.email ? storedUser : null)),
      create: vi.fn(),
      listPage: vi.fn(),
      softDelete: vi.fn(),
    };

    // Minimal in-memory stand-in for the `user_security` row + the two
    // sessions SecurityService.ensureSeeded seeds on first access.
    const fakeSecurityRepo = {
      ensureState: vi.fn(async (userId: string) => {
        if (!securityState.has(userId)) {
          securityState.set(userId, { userId, twoFactorEnabled: false, twoFactorSecret: null });
        }
      }),
      findState: vi.fn(async (userId: string) => securityState.get(userId) ?? null),
      saveTwoFactorSecret: vi.fn(async (userId: string, secret: string) => {
        securityState.set(userId, { userId, twoFactorEnabled: false, twoFactorSecret: secret });
      }),
      confirmTwoFactor: vi.fn(async (userId: string) => {
        const row = securityState.get(userId);
        if (row) row.twoFactorEnabled = true;
      }),
      clearTwoFactor: vi.fn(async (userId: string) => {
        securityState.set(userId, { userId, twoFactorEnabled: false, twoFactorSecret: null });
      }),
      countSessions: vi.fn(async () => 1), // pretend already seeded — session seeding is irrelevant here
      seedSessions: vi.fn(),
      listSessions: vi.fn(async () => []),
      deleteSession: vi.fn(),
      deleteOtherSessions: vi.fn(),
    };

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
        client: (() => {
          const store = new Map<string, string>();
          return {
            call: async () => null,
            get: async (k: string) => store.get(k) ?? null,
            set: async (k: string, v: string) => {
              store.set(k, v);
              return 'OK';
            },
            getdel: async (k: string) => {
              const v = store.get(k);
              if (v === undefined) return null;
              store.delete(k);
              return v;
            },
            del: async (k: string) => (store.delete(k) ? 1 : 0),
            // TotpLockoutService (F1) — incr/expire back the per-user
            // failed-attempt counter.
            incr: async (k: string) => {
              const v = Number(store.get(k) ?? '0') + 1;
              store.set(k, String(v));
              return v;
            },
            expire: async () => 1,
          };
        })(),
        ping: async () => true,
        onModuleInit: () => Promise.resolve(),
        onModuleDestroy: () => Promise.resolve(),
      })
      .overrideProvider(UsersRepository)
      .useValue(fakeUsersRepo)
      .overrideProvider(SecurityRepository)
      .useValue(fakeSecurityRepo)
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

  async function login(totpCode?: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: storedUser.email, password: PASSWORD, ...(totpCode ? { totpCode } : {}) },
      headers: { 'content-type': 'application/json' },
    });
    return res;
  }

  it('logs in normally before any enrollment', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(typeof (res.json() as { accessToken: string }).accessToken).toBe('string');
  });

  it('walks the full enroll → confirm → login-challenge → disable lifecycle', async () => {
    const loginRes = await login();
    const accessToken = (loginRes.json() as { accessToken: string }).accessToken;
    const auth = { authorization: `Bearer ${accessToken}` };

    // Step 1/2: begin enrollment — secret persisted, still not enabled.
    const enroll = await app.inject({
      method: 'POST',
      url: '/v1/security/2fa/enroll',
      headers: auth,
    });
    expect(enroll.statusCode).toBe(200);
    const { twoFactorSecret, otpauthUri } = enroll.json() as {
      twoFactorSecret: string;
      otpauthUri: string;
    };
    expect(typeof twoFactorSecret).toBe('string');
    expect(otpauthUri).toContain('otpauth://totp/');

    // An unconfirmed secret must not gate login.
    const stillOpenLogin = await login();
    expect(stillOpenLogin.statusCode).toBe(200);

    // Step 2/2, wrong code first.
    const wrongConfirm = await app.inject({
      method: 'POST',
      url: '/v1/security/2fa/confirm',
      payload: { code: '000000' },
      headers: { ...auth, 'content-type': 'application/json' },
    });
    expect(wrongConfirm.statusCode).toBe(401);

    // Correct code flips the flag.
    const rightCode = authenticator.generate(twoFactorSecret);
    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/security/2fa/confirm',
      payload: { code: rightCode },
      headers: { ...auth, 'content-type': 'application/json' },
    });
    expect(confirm.statusCode).toBe(200);
    expect((confirm.json() as { twoFactorEnabled: boolean }).twoFactorEnabled).toBe(true);

    // Login now requires a code.
    const requiredRes = await login();
    expect(requiredRes.statusCode).toBe(401);
    expect(requiredRes.json()).toMatchObject({ code: 'totp_required' });

    // A wrong code is distinguishable from a missing one.
    const invalidRes = await login('000000');
    expect(invalidRes.statusCode).toBe(401);
    expect(invalidRes.json()).toMatchObject({ code: 'totp_invalid' });

    // The right code logs in.
    const okRes = await login(authenticator.generate(twoFactorSecret));
    expect(okRes.statusCode).toBe(200);
    expect(typeof (okRes.json() as { accessToken: string }).accessToken).toBe('string');

    // Disabling requires the current code too.
    const badDisable = await app.inject({
      method: 'POST',
      url: '/v1/security/2fa/disable',
      payload: { code: '000000' },
      headers: { ...auth, 'content-type': 'application/json' },
    });
    expect(badDisable.statusCode).toBe(401);

    const disable = await app.inject({
      method: 'POST',
      url: '/v1/security/2fa/disable',
      payload: { code: authenticator.generate(twoFactorSecret) },
      headers: { ...auth, 'content-type': 'application/json' },
    });
    expect(disable.statusCode).toBe(200);
    expect((disable.json() as { twoFactorEnabled: boolean }).twoFactorEnabled).toBe(false);

    // Back to normal — no code needed.
    const finalLogin = await login();
    expect(finalLogin.statusCode).toBe(200);
  });

  it('lets an in-progress, unconfirmed enrollment be cancelled with no body at all', async () => {
    const loginRes = await login();
    const accessToken = (loginRes.json() as { accessToken: string }).accessToken;
    const auth = { authorization: `Bearer ${accessToken}` };

    await app.inject({ method: 'POST', url: '/v1/security/2fa/enroll', headers: auth });

    // No body, no content-type — Fastify hands the DTO `undefined`;
    // DisableTwoFactorSchema.default({}) must absorb that.
    const cancel = await app.inject({
      method: 'POST',
      url: '/v1/security/2fa/disable',
      headers: auth,
    });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { twoFactorEnabled: boolean }).twoFactorEnabled).toBe(false);
  });

  it('locks out /2fa/confirm after 5 consecutive wrong codes, blocking even the correct one (F1)', async () => {
    const loginRes = await login();
    const accessToken = (loginRes.json() as { accessToken: string }).accessToken;
    const auth = { authorization: `Bearer ${accessToken}` };

    const enroll = await app.inject({
      method: 'POST',
      url: '/v1/security/2fa/enroll',
      headers: auth,
    });
    const { twoFactorSecret } = enroll.json() as { twoFactorSecret: string };

    for (let i = 0; i < 5; i++) {
      const wrong = await app.inject({
        method: 'POST',
        url: '/v1/security/2fa/confirm',
        payload: { code: '000000' },
        headers: { ...auth, 'content-type': 'application/json' },
      });
      expect(wrong.statusCode).toBe(401);
    }

    // The account is now locked — even the objectively correct code is rejected.
    const lockedAttempt = await app.inject({
      method: 'POST',
      url: '/v1/security/2fa/confirm',
      payload: { code: authenticator.generate(twoFactorSecret) },
      headers: { ...auth, 'content-type': 'application/json' },
    });
    expect(lockedAttempt.statusCode).toBe(401);
    expect(lockedAttempt.json()).toMatchObject({ code: 'totp_locked' });
  });
});
