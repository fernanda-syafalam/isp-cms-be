import fastifyCookie from '@fastify/cookie';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { DrizzleService } from '../src/infrastructure/database/drizzle.service';
import type { User } from '../src/infrastructure/database/schema/users.schema';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { UsersRepository } from '../src/modules/users/users.repository';

const OLD_PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'brand-new-password-42';

/**
 * P1.4 end-to-end: login with the old password, rotate it through
 * POST /v1/auth/change-password, and prove the credential actually moved
 * (old login 401s, new login 200s). The in-memory repository mutates its
 * stored hash on updatePasswordHash, so the whole pipeline — guard,
 * DTO validation, argon2 verify + rehash — is exercised for real.
 */
describe('Password lifecycle (e2e)', () => {
  let app: NestFastifyApplication;
  let storedUser: User;

  const repoState = {
    updatePasswordHash: async (id: string, passwordHash: string) => {
      if (id !== storedUser.id) throw new Error('unknown user');
      storedUser.passwordHash = passwordHash;
    },
  };

  const fakeRepo = {
    findById: vi.fn(async (id: string) => (id === storedUser.id ? storedUser : null)),
    findByEmail: vi.fn(async (email: string) => (email === storedUser.email ? storedUser : null)),
    create: vi.fn(),
    listPage: vi.fn(),
    softDelete: vi.fn(),
    updatePasswordHash: vi.fn(repoState.updatePasswordHash),
  };

  beforeAll(async () => {
    storedUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'alice@b.test',
      fullName: 'Alice',
      passwordHash: await argon2.hash(OLD_PASSWORD, { type: argon2.argon2id }),
      role: 'customer',
      resellerId: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      deletedAt: null,
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
          };
        })(),
        ping: async () => true,
        onModuleInit: () => Promise.resolve(),
        onModuleDestroy: () => Promise.resolve(),
      })
      .overrideProvider(UsersRepository)
      .useValue(fakeRepo)
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

  async function login(password: string): Promise<{ status: number; accessToken?: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: storedUser.email, password },
      headers: { 'content-type': 'application/json' },
    });
    return {
      status: res.statusCode,
      accessToken:
        res.statusCode === 200 ? (res.json() as { accessToken: string }).accessToken : undefined,
    };
  }

  it('rejects an unauthenticated change-password with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/change-password',
      payload: { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong current password with 400 and keeps the old credential working', async () => {
    const { accessToken } = await login(OLD_PASSWORD);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/change-password',
      payload: { currentPassword: 'not-the-password', newPassword: NEW_PASSWORD },
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
    });
    expect(res.statusCode).toBe(400);
    expect((await login(OLD_PASSWORD)).status).toBe(200);
  });

  it('rejects a too-short new password with 400', async () => {
    const { accessToken } = await login(OLD_PASSWORD);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/change-password',
      payload: { currentPassword: OLD_PASSWORD, newPassword: 'short' },
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rotates the credential: old login dies, new login works', async () => {
    const { accessToken } = await login(OLD_PASSWORD);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/change-password',
      payload: { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
    });
    expect(res.statusCode).toBe(204);

    expect((await login(OLD_PASSWORD)).status).toBe(401);
    expect((await login(NEW_PASSWORD)).status).toBe(200);
  });
});
