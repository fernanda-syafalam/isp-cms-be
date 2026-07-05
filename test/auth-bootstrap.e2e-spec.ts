import fastifyCookie from '@fastify/cookie';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { DrizzleService } from '../src/infrastructure/database/drizzle.service';
import type { NewUser, User } from '../src/infrastructure/database/schema/users.schema';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { UsersRepository } from '../src/modules/users/users.repository';

/**
 * E2E for the first-run bootstrap flow (P3.E.1) against a stateful in-memory
 * users store that STARTS EMPTY — so it exercises the real controller →
 * service → advisory-lock path end to end: required:true → create admin →
 * required:false → second attempt 409. No Postgres/Docker needed.
 */
describe('Auth bootstrap (e2e)', () => {
  let app: NestFastifyApplication;
  const store: User[] = [];

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
        client: (() => {
          const kv = new Map<string, string>();
          return {
            call: async () => null,
            get: async (k: string) => kv.get(k) ?? null,
            set: async (k: string, v: string) => {
              kv.set(k, v);
              return 'OK';
            },
            getdel: async (k: string) => {
              const v = kv.get(k);
              if (v === undefined) return null;
              kv.delete(k);
              return v;
            },
            del: async (k: string) => (kv.delete(k) ? 1 : 0),
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

  const payload = {
    email: 'root@ashnet.id',
    fullName: 'Root Admin',
    password: 'correct-horse-battery-staple',
  };

  it('reports required:true on an empty instance', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/bootstrap' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ required: true });
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
    expect(res.json()).toEqual({ required: false });
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
