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
import { CustomersService } from '../src/modules/customers/customers.service';
import type { CustomerResponse } from '../src/modules/customers/dto/customer-response.dto';
import type { TicketResponse } from '../src/modules/tickets/dto/ticket-response.dto';
import { TicketsService } from '../src/modules/tickets/tickets.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { WorkOrderResponse } from '../src/modules/work-orders/dto/work-order-response.dto';
import { WorkOrdersService } from '../src/modules/work-orders/work-orders.service';

/**
 * HTTP-boundary safety net (audit finding TEST-C1) — one representative
 * mutation per remaining domain (customers, work-orders, tickets), on top
 * of the money/billing/voucher/payout suites. Each controller's own
 * Service is faked so this proves DTO validation + @Roles wiring +
 * ZodSerializerDto shape only; the domain logic underneath is covered by
 * the existing *.service.spec.ts files.
 */
describe('Representative domain mutations (e2e)', () => {
  let app: NestFastifyApplication;

  const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000c1';
  const WORK_ORDER_ID = '00000000-0000-0000-0000-0000000000w1';
  const TICKET_ID = '00000000-0000-0000-0000-0000000000t1';

  const actor: User = {
    id: '00000000-0000-0000-0000-000000000001',
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

  const CUSTOMER: CustomerResponse = {
    id: CUSTOMER_ID,
    customerNo: 'CUST-9001',
    fullName: 'Budi Santoso',
    phone: '081234567890',
    email: 'budi@b.test',
    address: 'Jl. Mawar 1',
    areaId: null,
    areaName: null,
    planId: '00000000-0000-4000-8000-0000000000a1',
    planName: 'Home 20',
    status: 'prospek',
    holdReason: null,
    outstanding: 0,
    billingAnchorDay: null,
    npwp: null,
    ktp: null,
    consentAt: null,
    resellerName: null,
    connection: null,
    joinedAt: '2026-07-08T00:00:00.000Z',
  };

  const ISOLATED_CUSTOMER: CustomerResponse = {
    ...CUSTOMER,
    status: 'isolir',
    holdReason: 'overdue',
  };

  const WORK_ORDER: WorkOrderResponse = {
    id: WORK_ORDER_ID,
    code: 'WO-000123',
    type: 'install',
    customerId: CUSTOMER_ID,
    customerName: 'Budi Santoso',
    technician: 'Agus',
    scheduledAt: '2026-07-08T00:00:00.000Z',
    status: 'in_progress',
    ticketId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    scannedOnuSerial: null,
    measuredRxPower: null,
    photos: null,
    signatureUrl: null,
    gpsLat: null,
    gpsLng: null,
    completionNotes: null,
    completedAt: null,
    completedBy: null,
  };

  const COMPLETED_WORK_ORDER: WorkOrderResponse = {
    ...WORK_ORDER,
    status: 'done',
    completedAt: '2026-07-08T01:00:00.000Z',
    completedBy: 'Agus',
  };

  const TICKET: TicketResponse = {
    id: TICKET_ID,
    code: 'TCK-000123',
    subject: 'Koneksi putus',
    customerId: CUSTOMER_ID,
    customerName: 'Budi Santoso',
    priority: 'high',
    status: 'open',
    assignee: null,
    slaDueAt: '2026-07-08T04:00:00.000Z',
    createdAt: '2026-07-08T00:00:00.000Z',
    category: 'koneksi_putus',
    photoUrl: null,
    csatRating: null,
    csatComment: null,
    csatAt: null,
  };

  const fakeCustomersService = {
    list: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(async () => CUSTOMER),
    isolate: vi.fn(async () => ISOLATED_CUSTOMER),
  };

  const fakeWorkOrdersService = {
    list: vi.fn(),
    start: vi.fn(async () => WORK_ORDER),
    complete: vi.fn(async () => COMPLETED_WORK_ORDER),
  };

  const fakeTicketsService = {
    list: vi.fn(),
    findById: vi.fn(),
    listEvents: vi.fn(),
    create: vi.fn(async () => TICKET),
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
      .overrideProvider(CustomersService)
      .useValue(fakeCustomersService)
      .overrideProvider(WorkOrdersService)
      .useValue(fakeWorkOrdersService)
      .overrideProvider(TicketsService)
      .useValue(fakeTicketsService)
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

  describe('Customers', () => {
    it('POST /v1/customers — staff: 201 + shape', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/customers',
        payload: {
          fullName: 'Budi Santoso',
          phone: '081234567890',
          email: 'budi@b.test',
          address: 'Jl. Mawar 1',
          planId: '00000000-0000-4000-8000-0000000000a1',
        },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('staff')}`,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(CUSTOMER);
    });

    it('POST /v1/customers/:id/isolate — staff: 201 + shape', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/customers/${CUSTOMER_ID}/isolate`,
        headers: { authorization: `Bearer ${await tokenFor('staff')}` },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(ISOLATED_CUSTOMER);
    });

    it('mitra: 403 on both mutations (mitra is read-only, scoped to its own reseller)', async () => {
      const token = await tokenFor('mitra');
      const create = await app.inject({
        method: 'POST',
        url: '/v1/customers',
        payload: {
          fullName: 'Budi Santoso',
          phone: '081234567890',
          email: 'budi@b.test',
          address: 'Jl. Mawar 1',
          planId: '00000000-0000-4000-8000-0000000000a1',
        },
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      });
      expect(create.statusCode).toBe(403);

      const isolate = await app.inject({
        method: 'POST',
        url: `/v1/customers/${CUSTOMER_ID}/isolate`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(isolate.statusCode).toBe(403);
    });
  });

  describe('Work orders', () => {
    it('POST /v1/work-orders/:id/start — teknisi: 201 + shape', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/work-orders/${WORK_ORDER_ID}/start`,
        headers: { authorization: `Bearer ${await tokenFor('teknisi')}` },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(WORK_ORDER);
    });

    it('POST /v1/work-orders/:id/complete — teknisi: 201 + shape (evidence body optional)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/work-orders/${WORK_ORDER_ID}/complete`,
        payload: { technician: 'Agus', notes: 'Terpasang' },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('teknisi')}`,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(COMPLETED_WORK_ORDER);
    });

    it('customer: 403 on both (work-orders is admin/staff/teknisi only)', async () => {
      const token = await tokenFor('customer');
      const start = await app.inject({
        method: 'POST',
        url: `/v1/work-orders/${WORK_ORDER_ID}/start`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(start.statusCode).toBe(403);

      const complete = await app.inject({
        method: 'POST',
        url: `/v1/work-orders/${WORK_ORDER_ID}/complete`,
        payload: {},
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      });
      expect(complete.statusCode).toBe(403);
    });
  });

  describe('Tickets', () => {
    it('POST /v1/tickets — staff: 201 + shape', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tickets',
        payload: { subject: 'Koneksi putus', customerName: 'Budi Santoso', priority: 'high' },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('staff')}`,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(TICKET);
    });

    // Already covered as a guard-only assertion in rbac.e2e-spec.ts; this
    // one additionally asserts the shape locks correctly for the allowed
    // roles, and that teknisi (read-allowed, create-forbidden) still 403s.
    it('teknisi: 403 on create (read-only on tickets)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tickets',
        payload: { subject: 'Koneksi putus', customerName: 'Budi Santoso', priority: 'high' },
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor('teknisi')}`,
        },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
