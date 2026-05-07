import { VersioningType } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { DrizzleService } from '../src/infrastructure/database/drizzle.service';
import type { User } from '../src/infrastructure/database/schema/users.schema';
import { UsersRepository } from '../src/modules/users/users.repository';

/**
 * E2E coverage for the auth flow without a real Postgres. The
 * UsersRepository is overridden with an in-memory fake so the test
 * exercises the full pipeline (controller → guard → strategy → service)
 * but stays fast and offline.
 */
describe('Auth (e2e)', () => {
  let app: NestFastifyApplication;
  let storedUser: User;

  beforeAll(async () => {
    const passwordHash = await argon2.hash('correct-horse-battery-staple', {
      type: argon2.argon2id,
    });
    storedUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'alice@b.test',
      fullName: 'Alice',
      passwordHash,
      role: 'customer',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      deletedAt: null,
    };

    const fakeRepo = {
      findById: vi.fn(async (id: string) => (id === storedUser.id ? storedUser : null)),
      findByEmail: vi.fn(async (email: string) =>
        email === storedUser.email ? storedUser : null,
      ),
      create: vi.fn(),
      listPage: vi.fn(),
      softDelete: vi.fn(),
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
      .overrideProvider(UsersRepository)
      .useValue(fakeRepo)
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /v1/auth/login returns 200 + accessToken on valid credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: storedUser.email, password: 'correct-horse-battery-staple' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accessToken: string; user: { id: string } };
    expect(typeof body.accessToken).toBe('string');
    expect(body.user.id).toBe(storedUser.id);
  });

  it('POST /v1/auth/login returns 401 on bad password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: storedUser.email, password: 'wrong-password' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/auth/me returns 401 without a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/auth/me returns the current user when the bearer is valid', async () => {
    const jwt = app.get(JwtService);
    const token = await jwt.signAsync({ sub: storedUser.id, role: storedUser.role });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: storedUser.id,
      email: storedUser.email,
      role: storedUser.role,
    });
  });
});
