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
import { TopologyRepository } from '../src/modules/topology/topology.repository';
import { UsersRepository } from '../src/modules/users/users.repository';

/** Topology is back in the MVP: staff roles read it, only admin may delete nodes. */
describe('Topology routes (e2e)', () => {
  let app: NestFastifyApplication;

  const baseUser: User = {
    id: '',
    email: '',
    fullName: 'User',
    passwordHash: 'irrelevant',
    role: 'admin',
    resellerId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  };
  const admin: User = {
    ...baseUser,
    id: '00000000-0000-4000-8000-000000000001',
    email: 'admin@b.test',
    role: 'admin',
  };
  const technician: User = {
    ...baseUser,
    id: '00000000-0000-4000-8000-000000000002',
    email: 'tech@b.test',
    role: 'teknisi',
  };
  const staff: User = {
    ...baseUser,
    id: '00000000-0000-4000-8000-000000000003',
    email: 'staff@b.test',
    role: 'staff',
  };
  const users = [admin, technician, staff];

  const fakeUsersRepo = {
    findById: vi.fn(async (id: string) => users.find((u) => u.id === id) ?? null),
    findByEmail: vi.fn(async () => null),
  };
  const fakeTopologyRepo = {
    ensureSeeded: vi.fn(async () => undefined),
    listNodes: vi.fn(async () => []),
    listSplitters: vi.fn(async () => []),
    listStrands: vi.fn(async () => []),
    deleteNode: vi.fn(async () => false),
  };

  const NODE_ID = '00000000-0000-4000-8000-0000000000d1';

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
      .overrideProvider(TopologyRepository)
      .useValue(fakeTopologyRepo)
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

  async function headersFor(user: User): Promise<{ authorization: string }> {
    const token = await app.get(JwtService).signAsync({ sub: user.id, role: user.role });
    return { authorization: `Bearer ${token}` };
  }

  it.each([
    ['admin', admin],
    ['teknisi', technician],
  ])('GET /v1/topology is 200 for %s', async (_name, user) => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/topology',
      headers: await headersFor(user),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0 });
  });

  it('GET /v1/topology is 401 without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/topology' });
    expect(res.statusCode).toBe(401);
  });

  it('DELETE /v1/topology/:id is 403 for teknisi and never reaches the repo', async () => {
    fakeTopologyRepo.deleteNode.mockClear();
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/topology/${NODE_ID}`,
      headers: await headersFor(technician),
    });
    expect(res.statusCode).toBe(403);
    expect(fakeTopologyRepo.deleteNode).not.toHaveBeenCalled();
  });

  it('DELETE /v1/topology/:id passes RBAC for admin (service 404 for unknown node)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/topology/${NODE_ID}`,
      headers: await headersFor(admin),
    });
    expect(res.statusCode).toBe(404);
    expect(fakeTopologyRepo.deleteNode).toHaveBeenCalledWith(NODE_ID);
  });

  it('DELETE /v1/topology/:id is 403 for staff', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/topology/${NODE_ID}`,
      headers: await headersFor(staff),
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /v1/topology rejects an out-of-range latitude with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/topology',
      headers: await headersFor(admin),
      payload: { name: 'ODP X', type: 'odp', status: 'up', parentId: null, lat: 999, lng: 110 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/topology/customer-drop is closed (404) for admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/topology/customer-drop',
      headers: await headersFor(admin),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});
