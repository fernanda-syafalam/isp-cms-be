import fastifyCookie from '@fastify/cookie';
import { VersioningType } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { DrizzleService } from '../src/infrastructure/database/drizzle.service';
import type { User } from '../src/infrastructure/database/schema/users.schema';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { InvoicesRepository } from '../src/modules/invoices/invoices.repository';
import { TicketsRepository } from '../src/modules/tickets/tickets.repository';
import { UsersRepository } from '../src/modules/users/users.repository';

/**
 * `customerId` query filter on GET /v1/invoices and GET /v1/tickets: a valid
 * UUID reaches the repository untouched, anything else is a 400 from the
 * zod query schema before any repository call.
 */
describe('List customerId filter (e2e)', () => {
  let app: NestFastifyApplication;

  const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';

  const actor: User = {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'actor@b.test',
    fullName: 'Actor',
    passwordHash: 'irrelevant',
    role: 'admin',
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

  const fakeInvoicesRepo = {
    list: vi.fn(async () => ({
      items: [],
      total: 0,
      summary: {
        outstanding: 0,
        overdue: 0,
        unpaidCount: 0,
        total: 0,
        byStatus: { paid: 0, partial: 0, pending: 0, overdue: 0, draft: 0 },
      },
    })),
  };

  const fakeTicketsRepo = {
    list: vi.fn(async () => ({
      items: [],
      total: 0,
      summary: { total: 0, byStatus: { open: 0, in_progress: 0, resolved: 0, breached: 0 } },
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
      .overrideProvider(InvoicesRepository)
      .useValue(fakeInvoicesRepo)
      .overrideProvider(TicketsRepository)
      .useValue(fakeTicketsRepo)
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

  beforeEach(() => {
    fakeInvoicesRepo.list.mockClear();
    fakeTicketsRepo.list.mockClear();
  });

  const get = async (url: string) => {
    const token = await app.get(JwtService).signAsync({ sub: actor.id, role: actor.role });
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  };

  const cases = [
    { url: '/v1/invoices', repo: fakeInvoicesRepo },
    { url: '/v1/tickets', repo: fakeTicketsRepo },
  ] as const;

  describe.each(cases)('GET $url', ({ url, repo }) => {
    it('200 and forwards a valid customerId to the repository', async () => {
      const res = await get(`${url}?customerId=${CUSTOMER_ID}`);
      expect(res.statusCode).toBe(200);
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ customerId: CUSTOMER_ID }));
    });

    it('omits customerId when the query param is absent', async () => {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(repo.list).toHaveBeenCalledWith(
        expect.not.objectContaining({ customerId: expect.anything() }),
      );
    });

    it('400 for a non-UUID customerId, without touching the repository', async () => {
      const res = await get(`${url}?customerId=not-a-uuid`);
      expect(res.statusCode).toBe(400);
      expect(repo.list).not.toHaveBeenCalled();
    });
  });
});
