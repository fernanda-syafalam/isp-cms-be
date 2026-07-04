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

/**
 * Regression coverage for P0.1: POST /v1/users must never be public.
 * The payload carries `role` (including `admin`), so an open endpoint
 * lets an unauthenticated caller mint an admin account. Same in-memory
 * repository override pattern as auth.e2e-spec.ts.
 */
describe('Users create gate (e2e)', () => {
  let app: NestFastifyApplication;

  const createdUser: User = {
    id: '00000000-0000-0000-0000-000000000042',
    email: 'new-admin@b.test',
    fullName: 'New Admin',
    passwordHash: 'irrelevant',
    role: 'admin',
    resellerId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  };

  const attemptPayload = {
    email: 'new-admin@b.test',
    fullName: 'New Admin',
    password: 'correct-horse-battery-staple',
    role: 'admin',
  };

  // JwtStrategy.validate resolves the caller from the repository and takes
  // the role from the stored user, not the token — so the acting user's
  // role is swapped per test via this mutable record.
  const actor: User = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'actor@b.test',
    fullName: 'Actor',
    passwordHash: 'irrelevant',
    role: 'admin',
    resellerId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  };

  const fakeRepo = {
    findById: vi.fn(async (id: string) => (id === actor.id ? actor : null)),
    findByEmail: vi.fn(async () => null),
    create: vi.fn(async () => createdUser),
    listPage: vi.fn(),
    softDelete: vi.fn(),
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

  async function tokenFor(role: User['role']): Promise<string> {
    actor.role = role;
    const jwt = app.get(JwtService);
    return jwt.signAsync({ sub: actor.id, role });
  }

  it('rejects an unauthenticated create with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users',
      payload: attemptPayload,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
    expect(fakeRepo.create).not.toHaveBeenCalled();
  });

  it('rejects a staff create with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users',
      payload: attemptPayload,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await tokenFor('staff')}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(fakeRepo.create).not.toHaveBeenCalled();
  });

  it('rejects a customer create with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users',
      payload: attemptPayload,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await tokenFor('customer')}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(fakeRepo.create).not.toHaveBeenCalled();
  });

  it('allows an admin create with 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users',
      payload: attemptPayload,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await tokenFor('admin')}`,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(fakeRepo.create).toHaveBeenCalledTimes(1);
    const body = res.json() as { id: string; passwordHash?: string };
    expect(body.id).toBe(createdUser.id);
    expect(body.passwordHash).toBeUndefined();
  });
});
