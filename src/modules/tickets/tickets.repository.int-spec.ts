import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { ticketEvents, tickets } from '../../infrastructure/database/schema/tickets.schema';
import { TicketsRepository } from './tickets.repository';

/**
 * Real Postgres integration test for TicketsRepository. Requires Docker.
 * Schema applied by hand (mirroring migrations 0002-0005).
 */
describe('TicketsRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: TicketsRepository;
  let customerId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE plan_status AS ENUM ('active', 'archived');
      CREATE TABLE plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(80) NOT NULL, speed_mbps integer NOT NULL,
        price_monthly integer NOT NULL, status plan_status NOT NULL DEFAULT 'active',
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE customer_status AS ENUM ('prospek', 'instalasi', 'aktif', 'isolir', 'berhenti');
      CREATE TYPE customer_hold_reason AS ENUM ('overdue', 'voluntary');
      CREATE SEQUENCE customer_no_seq START WITH 9001;
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        lat double precision, lng double precision, odp_id varchar(60), billing_anchor_day smallint,
        customer_no varchar(32) NOT NULL UNIQUE DEFAULT ('CUST-' || nextval('customer_no_seq')),
        full_name varchar(120) NOT NULL, phone varchar(20) NOT NULL, email varchar(255), user_id uuid UNIQUE,
        address varchar(255) NOT NULL, area_id uuid, area_name varchar(120),
        plan_id uuid NOT NULL REFERENCES plans(id),
        status customer_status NOT NULL DEFAULT 'prospek', hold_reason customer_hold_reason,
        outstanding integer NOT NULL DEFAULT 0, npwp varchar(40), ktp varchar(32),
        consent_at timestamptz(3), data_deletion_requested_at timestamptz(3),
        reseller_name varchar(120), reseller_id uuid, connection jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE ticket_status AS ENUM ('open', 'in_progress', 'resolved', 'breached');
      CREATE TYPE ticket_priority AS ENUM ('low', 'medium', 'high', 'urgent');
      CREATE TYPE ticket_event_kind AS ENUM ('created', 'comment', 'status', 'assign', 'workorder', 'csat');
      CREATE TYPE ticket_category AS ENUM ('koneksi_putus', 'lambat', 'tagihan', 'perangkat', 'lainnya');
      CREATE SEQUENCE ticket_code_seq START WITH 2001;
      CREATE TABLE tickets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(32) NOT NULL UNIQUE DEFAULT ('TKT-' || nextval('ticket_code_seq')),
        subject varchar(160) NOT NULL,
        customer_id uuid REFERENCES customers(id),
        customer_name varchar(120) NOT NULL,
        priority ticket_priority NOT NULL,
        status ticket_status NOT NULL DEFAULT 'open',
        assignee varchar(120),
        sla_due_at timestamptz(3) NOT NULL,
        category ticket_category,
        photo_url varchar(500),
        csat_rating integer,
        csat_comment varchar(500),
        csat_at timestamptz(3),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TABLE ticket_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ticket_id uuid NOT NULL REFERENCES tickets(id),
        kind ticket_event_kind NOT NULL,
        author varchar(120) NOT NULL,
        body varchar(500) NOT NULL,
        at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    const [plan] = await db
      .insert(plans)
      .values({ name: 'Home 20', speedMbps: 20, priceMonthly: 200_000 })
      .returning();
    if (!plan) throw new Error('plan seed failed');
    const [customer] = await db
      .insert(customers)
      .values({
        fullName: 'Budi',
        phone: '0811',
        address: 'Jl. A',
        planId: plan.id,
      })
      .returning();
    if (!customer) throw new Error('customer seed failed');
    customerId = customer.id;

    repo = new TicketsRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(ticketEvents);
    await db.delete(tickets);
  });

  const newTicket = (over: Partial<typeof tickets.$inferInsert> = {}) => ({
    subject: 'Internet mati',
    customerName: 'Budi',
    priority: 'high' as const,
    customerId,
    slaDueAt: new Date('2026-06-16T00:00:00.000Z'),
    ...over,
  });

  it('creates tickets with a sequential TKT code', async () => {
    const a = await repo.create(newTicket());
    const b = await repo.create(newTicket());
    expect(a.code).toMatch(/^TKT-\d+$/);
    expect(Number(b.code.split('-')[1])).toBe(Number(a.code.split('-')[1]) + 1);
    expect(a.status).toBe('open');
  });

  it('accepts a ticket with no matching subscriber (null customerId)', async () => {
    const t = await repo.create(newTicket({ customerId: null, customerName: 'Unknown' }));
    expect(t.customerId).toBeNull();
  });

  it('lists by status with a real total and limit/offset', async () => {
    await repo.create(newTicket());
    await repo.create(newTicket({ status: 'resolved' }));
    await repo.create(newTicket({ status: 'resolved' }));

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);

    const resolved = await repo.list({
      status: 'resolved',
      limit: 50,
      offset: 0,
    });
    expect(resolved.total).toBe(2);

    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // list — full-set summary aggregate (T1, FE contract parity)
  // ---------------------------------------------------------------------------

  describe('list — summary aggregate', () => {
    it('summary.byStatus counts every ticket regardless of the status filter', async () => {
      await repo.create(newTicket({ status: 'open' }));
      await repo.create(newTicket({ status: 'in_progress' }));
      await repo.create(newTicket({ status: 'resolved' }));
      await repo.create(newTicket({ status: 'resolved' }));
      await repo.create(newTicket({ status: 'breached' }));

      // Filtered view: only resolved
      const result = await repo.list({ status: 'resolved', limit: 50, offset: 0 });
      expect(result.total).toBe(2); // filtered total
      expect(result.items).toHaveLength(2);

      // Full-set summary — must still reflect ALL 5 tickets across statuses
      expect(result.summary).toEqual({
        total: 5,
        byStatus: { open: 1, in_progress: 1, resolved: 2, breached: 1 },
      });
    });

    it('summary does not change when q matches only some tickets', async () => {
      await repo.create(newTicket({ status: 'open', subject: 'Internet mati total' }));
      await repo.create(newTicket({ status: 'resolved', subject: 'Lambat di jam sibuk' }));
      await repo.create(newTicket({ status: 'breached', subject: 'WiFi putus-putus' }));

      const filtered = await repo.list({ q: 'mati', limit: 50, offset: 0 });
      expect(filtered.total).toBe(1); // filtered total

      const all = await repo.list({ limit: 50, offset: 0 });

      // Summary must be identical — q doesn't affect it either.
      expect(filtered.summary).toEqual(all.summary);
      expect(filtered.summary).toEqual({
        total: 3,
        byStatus: { open: 1, in_progress: 0, resolved: 1, breached: 1 },
      });
    });

    it('zero-fills every status key when the table is empty', async () => {
      const result = await repo.list({ limit: 50, offset: 0 });
      expect(result.summary).toEqual({
        total: 0,
        byStatus: { open: 0, in_progress: 0, resolved: 0, breached: 0 },
      });
    });

    it('limit/offset paging does not affect the summary', async () => {
      await repo.create(newTicket({ status: 'open' }));
      await repo.create(newTicket({ status: 'resolved' }));
      await repo.create(newTicket({ status: 'breached' }));

      const page1 = await repo.list({ limit: 1, offset: 0 });
      const page2 = await repo.list({ limit: 1, offset: 1 });

      expect(page1.summary).toEqual(page2.summary);
      expect(page1.summary.total).toBe(3);
    });

    it('breached is counted as its own status bucket, not folded into resolved', async () => {
      await repo.create(newTicket({ status: 'breached' }));
      await repo.create(newTicket({ status: 'resolved' }));

      const result = await repo.list({ limit: 50, offset: 0 });
      expect(result.summary.byStatus.breached).toBe(1);
      expect(result.summary.byStatus.resolved).toBe(1);
    });
  });

  it('updates fields and rejects a missing ticket', async () => {
    const created = await repo.create(newTicket());
    const updated = await repo.update(created.id, {
      status: 'in_progress',
      assignee: 'Teknisi Budi',
    });
    expect(updated.status).toBe('in_progress');
    expect(updated.assignee).toBe('Teknisi Budi');
    await expect(
      repo.update('00000000-0000-0000-0000-0000000000ff', {
        status: 'resolved',
      }),
    ).rejects.toThrow();
  });

  it('appends timeline events and lists them chronologically', async () => {
    const ticket = await repo.create(newTicket());
    await repo.addEvent({
      ticketId: ticket.id,
      kind: 'created',
      author: 'System',
      body: 'Tiket dibuat',
      at: new Date('2026-06-15T01:00:00.000Z'),
    });
    await repo.addEvent({
      ticketId: ticket.id,
      kind: 'comment',
      author: 'Agent Sari',
      body: 'Sedang dicek',
      at: new Date('2026-06-15T02:00:00.000Z'),
    });

    const events = await repo.listEvents(ticket.id);
    expect(events.total).toBe(2);
    expect(events.items.map((e) => e.kind)).toEqual(['created', 'comment']);
  });

  it('scopes tickets to one customer for the portal, newest first', async () => {
    await repo.create(
      newTicket({ subject: 'Lambat', createdAt: new Date('2026-06-14T00:00:00.000Z') }),
    );
    await repo.create(
      newTicket({ subject: 'Mati total', createdAt: new Date('2026-06-15T00:00:00.000Z') }),
    );
    // A ticket for nobody must not leak into a customer's list.
    await repo.create(newTicket({ customerId: null, customerName: 'Unknown' }));

    const mine = await repo.listByCustomer(customerId);
    expect(mine).toHaveLength(2);
    expect(mine[0]?.subject).toBe('Mati total');

    const other = '00000000-0000-0000-0000-0000000000ff';
    expect(await repo.listByCustomer(other)).toHaveLength(0);
  });

  it('counts tickets by status with every status present', async () => {
    await repo.create(newTicket());
    await repo.create(newTicket({ status: 'in_progress' }));
    await repo.create(newTicket({ status: 'resolved' }));
    await repo.create(newTicket({ status: 'resolved' }));
    await repo.create(newTicket({ status: 'breached' }));

    expect(await repo.countByStatus()).toEqual({
      open: 1,
      in_progress: 1,
      resolved: 2,
      breached: 1,
    });
  });

  it('submitCsat writes rating/comment and stamps csatAt', async () => {
    const ticket = await repo.create(newTicket({ status: 'resolved' }));
    expect(ticket.csatRating).toBeNull();

    const updated = await repo.submitCsat(ticket.id, { rating: 5, comment: 'Puas sekali' });

    expect(updated.csatRating).toBe(5);
    expect(updated.csatComment).toBe('Puas sekali');
    expect(updated.csatAt).toBeInstanceOf(Date);
  });

  it('submitCsat accepts a null comment', async () => {
    const ticket = await repo.create(newTicket({ status: 'resolved' }));
    const updated = await repo.submitCsat(ticket.id, { rating: 3, comment: null });
    expect(updated.csatRating).toBe(3);
    expect(updated.csatComment).toBeNull();
  });

  it('submitCsat rejects a missing ticket', async () => {
    await expect(
      repo.submitCsat('00000000-0000-0000-0000-0000000000ff', { rating: 4, comment: null }),
    ).rejects.toThrow();
  });

  it('findByIdForCustomer scopes to the owning customer, returning null otherwise', async () => {
    const ticket = await repo.create(newTicket());
    const other = '00000000-0000-0000-0000-0000000000ff';

    expect((await repo.findByIdForCustomer(ticket.id, customerId))?.id).toBe(ticket.id);
    expect(await repo.findByIdForCustomer(ticket.id, other)).toBeNull();
    expect(
      await repo.findByIdForCustomer('00000000-0000-0000-0000-000000000000', customerId),
    ).toBeNull();
  });

  it('markBreachedPastSla breaches only overdue open/in-progress tickets', async () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    const past = new Date('2026-06-19T00:00:00.000Z');
    const future = new Date('2026-06-21T00:00:00.000Z');

    const overdueOpen = await repo.create(newTicket({ status: 'open', slaDueAt: past }));
    const overdueInProgress = await repo.create(
      newTicket({ status: 'in_progress', slaDueAt: past }),
    );
    const withinSla = await repo.create(newTicket({ status: 'open', slaDueAt: future }));
    // Already resolved past its SLA — not re-touched by the scan.
    const resolvedLate = await repo.create(newTicket({ status: 'resolved', slaDueAt: past }));

    const breached = await repo.markBreachedPastSla(now);

    expect(breached.map((t) => t.id).sort()).toEqual([overdueOpen.id, overdueInProgress.id].sort());
    expect((await repo.findById(withinSla.id))?.status).toBe('open');
    expect((await repo.findById(resolvedLate.id))?.status).toBe('resolved');
  });
});
