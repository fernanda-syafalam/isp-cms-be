import fastifyCookie from '@fastify/cookie';
import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { DrizzleService } from '../src/infrastructure/database/drizzle.service';
import type { NewUser, User } from '../src/infrastructure/database/schema/users.schema';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { createFakeRedisClient } from '../src/test-utils/fake-redis-client';

/**
 * E2E for the first-run bootstrap flow (P3.E.1) against a stateful in-memory
 * users store that STARTS EMPTY — so it exercises the real controller →
 * service → advisory-lock path end to end: required:true → create admin →
 * required:false → second attempt 409. No Postgres/Docker needed.
 */
describe('Auth bootstrap (e2e)', () => {
  let app: NestFastifyApplication;
  const store: User[] = [];
  let appConfig: ConfigService;
  const settings: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const fakeRepo = {
      countAll: async () => store.length,
      createIfEmpty: async (input: NewUser): Promise<User | null> => {
        if (store.length > 0) return null;
        const row: User = {
          id: '00000000-0000-0000-0000-0000000000a1',
          email: input.email,
          fullName: input.fullName,
          passwordHash: input.passwordHash,
          role: input.role ?? 'admin',
          resellerId: input.resellerId ?? null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
          deletedAt: null,
        };
        store.push(row);
        return row;
      },
      findById: async (id: string) => store.find((u) => u.id === id) ?? null,
      findByEmail: async (email: string) => store.find((u) => u.email === email) ?? null,
      create: async () => {
        throw new Error('not used');
      },
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
        client: createFakeRedisClient(),
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
    // Drive the production/token predicate per test without booting in prod mode.
    appConfig = app.get(ConfigService);
    const realGet = appConfig.get.bind(appConfig) as (path: string, opts?: unknown) => unknown;
    vi.spyOn(appConfig, 'get').mockImplementation(((path: string, opts?: unknown) =>
      path in settings ? settings[path] : realGet(path, opts)) as never);
  });

  afterAll(async () => {
    await app.close();
  });

  const payload = {
    email: 'root@ashnet.id',
    fullName: 'Root Admin',
    password: 'correct-horse-battery-staple',
  };

  const post = (body: object) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap',
      payload: body,
      headers: { 'content-type': 'application/json' },
    });
  const token = 't'.repeat(40);

  it('reports required:true on an empty instance', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/bootstrap' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ required: true, tokenRequired: false });
  });

  describe('production deploy (BOOTSTRAP_TOKEN)', () => {
    it('GET reports tokenRequired:true', async () => {
      settings['app.nodeEnv'] = 'production';
      settings['app.deployEnv'] = undefined;
      const res = await app.inject({ method: 'GET', url: '/v1/auth/bootstrap' });
      expect(res.json()).toEqual({ required: true, tokenRequired: true });
    });

    it('403 when BOOTSTRAP_TOKEN is not configured', async () => {
      settings['app.bootstrapToken'] = undefined;
      expect((await post({ ...payload, bootstrapToken: token })).statusCode).toBe(403);
      expect(store).toHaveLength(0);
    });

    it('403 on a wrong or missing token', async () => {
      settings['app.bootstrapToken'] = token;
      expect((await post({ ...payload, bootstrapToken: 'w'.repeat(40) })).statusCode).toBe(403);
      expect((await post(payload)).statusCode).toBe(403);
      expect(store).toHaveLength(0);
    });

    it('201 with the right token', async () => {
      settings['app.bootstrapToken'] = token;
      const res = await post({ ...payload, bootstrapToken: token });
      expect(res.statusCode).toBe(201);
      store.length = 0; // reset for the dev-mode flow below
    });

    it('dev mode ignores the token', async () => {
      for (const k of Object.keys(settings)) delete settings[k];
      expect((await post({ ...payload, bootstrapToken: 'ignored' })).statusCode).toBe(201);
      store.length = 0;
    });
  });

  it('creates nothing yet: reset to the empty instance', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/bootstrap' });
    expect(res.json()).toEqual({ required: true, tokenRequired: false });
  });

  it('creates the first admin, logs in, and sets the refresh cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap',
      payload,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { accessToken: string; user: { role: string; email: string } };
    expect(typeof body.accessToken).toBe('string');
    expect(body.user.role).toBe('admin');
    expect(body.user.email).toBe(payload.email);
    expect(res.cookies.some((c) => c.name === 'refresh_token')).toBe(true);
  });

  it('reports required:false once an admin exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/bootstrap' });
    expect(res.json()).toEqual({ required: false, tokenRequired: false });
  });

  it('rejects a second bootstrap attempt with 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap',
      payload,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(409);
  });
});
