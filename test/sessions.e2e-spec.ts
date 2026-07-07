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
 * SEC-2 full-pipeline e2e coverage: the security page's session list +
 * revocation are backed by the REAL refresh-token store, not a seeded
 * display row. `RedisService` is overridden with an in-memory stand-in
 * (string get/set/getdel/del + set sadd/srem/smembers), so the whole
 * chain — login mints a session, `/v1/security` lists it for real,
 * revoking it actually invalidates the refresh token in "Redis", and
 * `/v1/auth/refresh` rejects it — is exercised for real, not mocked at
 * the service layer (unit-level coverage lives in
 * `refresh-token.service.spec.ts` and `security.service.spec.ts`).
 */
describe('Sessions (SEC-2, e2e)', () => {
  let app: NestFastifyApplication;
  let passwordHash: string;
  // Each `it` below registers its OWN user (see `registerUser`) rather than
  // sharing one across the whole file — the session index this feature is
  // testing is keyed per-user, so a shared user would let one test's
  // sessions bleed into the next's assertions.
  const usersById = new Map<string, User>();
  const usersByEmail = new Map<string, User>();
  const securityState = new Map<string, FakeSecurityRow>();
  let nextUserSuffix = 0;

  function registerUser(): User {
    nextUserSuffix += 1;
    const id = `00000000-0000-0000-0000-0000000000${String(nextUserSuffix).padStart(2, '0')}`;
    const user: User = {
      id,
      email: `session-user-${nextUserSuffix}@b.test`,
      fullName: 'Session User',
      passwordHash,
      role: 'staff',
      resellerId: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      deletedAt: null,
    };
    usersById.set(user.id, user);
    usersByEmail.set(user.email, user);
    return user;
  }

  beforeAll(async () => {
    passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });

    const fakeUsersRepo = {
      findById: vi.fn(async (id: string) => usersById.get(id) ?? null),
      findByEmail: vi.fn(async (email: string) => usersByEmail.get(email) ?? null),
      create: vi.fn(),
      listPage: vi.fn(),
      softDelete: vi.fn(),
    };

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
          const sets = new Map<string, Set<string>>();
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
            sadd: async (k: string, ...members: string[]) => {
              const set = sets.get(k) ?? new Set<string>();
              for (const m of members) set.add(m);
              sets.set(k, set);
              return members.length;
            },
            srem: async (k: string, ...members: string[]) => {
              const set = sets.get(k);
              if (!set) return 0;
              let removed = 0;
              for (const m of members) if (set.delete(m)) removed++;
              return removed;
            },
            smembers: async (k: string) => [...(sets.get(k) ?? [])],
            // TotpLockoutService (F1) — used by the F3 test's enroll/confirm.
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

  /** Pull a Set-Cookie value out of a light-my-request response. */
  function getCookie(
    res: { cookies: Array<{ name: string; value: string }> },
    name: string,
  ): string | undefined {
    return res.cookies.find((c) => c.name === name)?.value;
  }

  async function login(email: string, userAgent: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: PASSWORD },
      headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    });
    return {
      accessToken: (res.json() as { accessToken: string }).accessToken,
      refreshCookie: getCookie(res, 'refresh_token') as string,
    };
  }

  async function getSecurityState(accessToken: string) {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/security',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return res.json() as {
      sessions: Array<{ id: string; device: string; ip: string; current: boolean }>;
    };
  }

  async function refreshWith(cookie: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: `refresh_token=${cookie}` },
    });
  }

  it('login creates a real session; /v1/security lists it with metadata and current=true', async () => {
    const user = registerUser();
    const sessionA = await login(user.email, 'Mozilla/5.0 (Session A)');

    const state = await getSecurityState(sessionA.accessToken);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({
      device: 'Mozilla/5.0 (Session A)',
      current: true,
    });
  });

  it('refresh updates the SAME session (no duplicate row) and rotates the cookie', async () => {
    const user = registerUser();
    const session = await login(user.email, 'Mozilla/5.0 (Refresh Test)');
    const before = await getSecurityState(session.accessToken);
    expect(before.sessions).toHaveLength(1);
    const sessionId = before.sessions[0]?.id;

    const refreshed = await refreshWith(session.refreshCookie);
    expect(refreshed.statusCode).toBe(200);
    const newAccessToken = (refreshed.json() as { accessToken: string }).accessToken;

    const after = await getSecurityState(newAccessToken);
    expect(after.sessions).toHaveLength(1); // still one session, not two
    expect(after.sessions[0]?.id).toBe(sessionId);
    expect(after.sessions[0]?.current).toBe(true);
  });

  it('logout removes the session from the list', async () => {
    const user = registerUser();
    const session = await login(user.email, 'Mozilla/5.0 (Logout Test)');
    expect((await getSecurityState(session.accessToken)).sessions).toHaveLength(1);

    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: `refresh_token=${session.refreshCookie}` },
    });
    expect(logout.statusCode).toBe(204);

    // The access token is still valid (its own TTL) — the security page
    // read itself doesn't need the now-revoked refresh cookie — but the
    // session it belonged to is gone from the list.
    expect((await getSecurityState(session.accessToken)).sessions).toHaveLength(0);
  });

  it('"end other sessions" revokes every other refresh token for real — /v1/auth/refresh rejects them, the caller\'s own still works', async () => {
    const user = registerUser();
    const sessionA = await login(user.email, 'Mozilla/5.0 (Session A - revoke test)');
    const sessionB = await login(user.email, 'Mozilla/5.0 (Session B - revoke test)');

    // Both sessions show up for either caller.
    const listedFromA = await getSecurityState(sessionA.accessToken);
    expect(listedFromA.sessions).toHaveLength(2);
    expect(listedFromA.sessions.find((s) => s.device.includes('Session A'))?.current).toBe(true);
    expect(listedFromA.sessions.find((s) => s.device.includes('Session B'))?.current).toBe(false);

    const revoke = await app.inject({
      method: 'POST',
      url: '/v1/security/sessions/revoke-others',
      headers: { authorization: `Bearer ${sessionA.accessToken}` },
    });
    expect(revoke.statusCode).toBe(204);

    // Session B's refresh token is now dead in the real store.
    const refreshB = await refreshWith(sessionB.refreshCookie);
    expect(refreshB.statusCode).toBe(401);

    // Session A's own refresh token is untouched.
    const refreshA = await refreshWith(sessionA.refreshCookie);
    expect(refreshA.statusCode).toBe(200);

    // The security page (as session A) now shows only session A.
    const after = await getSecurityState(sessionA.accessToken);
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0]?.current).toBe(true);
  });

  it('revoking a single session by id kills its refresh token too', async () => {
    const user = registerUser();
    const sessionA = await login(user.email, 'Mozilla/5.0 (Single revoke A)');
    const sessionB = await login(user.email, 'Mozilla/5.0 (Single revoke B)');

    const listed = await getSecurityState(sessionA.accessToken);
    const targetId = listed.sessions.find((s) => s.device.includes('Single revoke B'))?.id;
    expect(targetId).toBeDefined();

    const revoke = await app.inject({
      method: 'POST',
      url: `/v1/security/sessions/${targetId}/revoke`,
      headers: { authorization: `Bearer ${sessionA.accessToken}` },
    });
    expect(revoke.statusCode).toBe(204);

    expect((await refreshWith(sessionB.refreshCookie)).statusCode).toBe(401);
    expect((await refreshWith(sessionA.refreshCookie)).statusCode).toBe(200);
  });

  it('revoking an unknown session id 404s', async () => {
    const user = registerUser();
    const session = await login(user.email, 'Mozilla/5.0 (404 test)');
    const revoke = await app.inject({
      method: 'POST',
      url: '/v1/security/sessions/00000000-0000-0000-0000-000000000000/revoke',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(revoke.statusCode).toBe(404);
  });

  it('F3: enabling 2FA revokes every OTHER active session, keeping the enabling session alive', async () => {
    const user = registerUser();
    const sessionA = await login(user.email, 'Mozilla/5.0 (F3 Session A)');
    const sessionB = await login(user.email, 'Mozilla/5.0 (F3 Session B)');
    const auth = { authorization: `Bearer ${sessionA.accessToken}` };

    const enroll = await app.inject({
      method: 'POST',
      url: '/v1/security/2fa/enroll',
      headers: auth,
    });
    const { twoFactorSecret } = enroll.json() as { twoFactorSecret: string };

    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/security/2fa/confirm',
      payload: { code: authenticator.generate(twoFactorSecret) },
      headers: { ...auth, 'content-type': 'application/json' },
    });
    expect(confirm.statusCode).toBe(200);
    expect((confirm.json() as { twoFactorEnabled: boolean }).twoFactorEnabled).toBe(true);

    // Session B is dead now — kicked out by F3, without ever being asked
    // to revoke anything itself.
    expect((await refreshWith(sessionB.refreshCookie)).statusCode).toBe(401);
    // Session A (the one that enabled 2FA) is untouched.
    expect((await refreshWith(sessionA.refreshCookie)).statusCode).toBe(200);
  });
});
