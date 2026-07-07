import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { workOrders } from '../../infrastructure/database/schema/work-orders.schema';
import { WorkOrdersRepository } from './work-orders.repository';

/**
 * Real Postgres integration test for WorkOrdersRepository. Requires Docker.
 * Schema applied by hand (mirroring migrations 0002-0006).
 */
describe('WorkOrdersRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: WorkOrdersRepository;
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
      CREATE TYPE work_order_type AS ENUM ('install', 'repair', 'dismantle');
      CREATE TYPE work_order_status AS ENUM ('scheduled', 'in_progress', 'done', 'cancelled');
      CREATE SEQUENCE work_order_code_seq START WITH 9001;
      CREATE TABLE work_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(32) NOT NULL UNIQUE DEFAULT ('WO-' || nextval('work_order_code_seq')),
        type work_order_type NOT NULL,
        customer_id uuid REFERENCES customers(id),
        customer_name varchar(120) NOT NULL,
        technician varchar(120),
        scheduled_at timestamptz(3) NOT NULL,
        status work_order_status NOT NULL DEFAULT 'scheduled',
        ticket_id uuid,
        scanned_onu_serial varchar(64), measured_rx_power real, photos jsonb,
        signature_url varchar(512), gps_lat real, gps_lng real,
        completion_notes text,
        completed_at timestamptz(3), completed_by varchar(120),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
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

    repo = new WorkOrdersRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(workOrders);
  });

  const newWo = (over: Partial<typeof workOrders.$inferInsert> = {}) => ({
    type: 'install' as const,
    customerId,
    customerName: 'Budi',
    technician: 'Teknisi Budi',
    scheduledAt: new Date('2026-06-16T00:00:00.000Z'),
    ...over,
  });

  it('creates work orders with a sequential WO code', async () => {
    const a = await repo.create(newWo());
    const b = await repo.create(newWo({ type: 'repair' }));
    expect(a.code).toMatch(/^WO-\d+$/);
    expect(Number(b.code.split('-')[1])).toBe(Number(a.code.split('-')[1]) + 1);
    expect(a.status).toBe('scheduled');
  });

  it('lists by status with a real total and limit/offset', async () => {
    await repo.create(newWo());
    await repo.create(newWo({ status: 'done' }));
    await repo.create(newWo({ status: 'done' }));

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);

    const done = await repo.list({ status: 'done', limit: 50, offset: 0 });
    expect(done.total).toBe(2);

    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // list — full-set summary aggregate (T1, FE contract parity)
  // ---------------------------------------------------------------------------

  describe('list — summary aggregate', () => {
    it('summary.byStatus counts every work order regardless of the status filter', async () => {
      await repo.create(newWo({ status: 'scheduled' }));
      await repo.create(newWo({ status: 'in_progress' }));
      await repo.create(newWo({ status: 'done' }));
      await repo.create(newWo({ status: 'done' }));
      await repo.create(newWo({ status: 'cancelled' }));

      // Filtered view: only done
      const result = await repo.list({ status: 'done', limit: 50, offset: 0 });
      expect(result.total).toBe(2); // filtered total
      expect(result.items).toHaveLength(2);

      // Full-set summary — must still reflect ALL 5 orders across statuses
      expect(result.summary).toEqual({
        total: 5,
        byStatus: { scheduled: 1, in_progress: 1, done: 2, cancelled: 1 },
      });
    });

    it('summary does not change when q/type/technician filters match only some orders', async () => {
      await repo.create(
        newWo({ status: 'scheduled', type: 'install', customerName: 'Alpha User' }),
      );
      await repo.create(newWo({ status: 'done', type: 'repair', customerName: 'Beta User' }));
      await repo.create(
        newWo({ status: 'cancelled', type: 'dismantle', technician: 'Teknisi Andi' }),
      );

      const filtered = await repo.list({ q: 'Alpha', limit: 50, offset: 0 });
      expect(filtered.total).toBe(1); // filtered total

      const all = await repo.list({ limit: 50, offset: 0 });

      // Summary must be identical — q/type/technician don't affect it either
      expect(filtered.summary).toEqual(all.summary);
      expect(filtered.summary).toEqual({
        total: 3,
        byStatus: { scheduled: 1, in_progress: 0, done: 1, cancelled: 1 },
      });
    });

    it('zero-fills every status key when the table is empty', async () => {
      const result = await repo.list({ limit: 50, offset: 0 });
      expect(result.summary).toEqual({
        total: 0,
        byStatus: { scheduled: 0, in_progress: 0, done: 0, cancelled: 0 },
      });
    });

    it('limit/offset paging does not affect the summary', async () => {
      await repo.create(newWo({ status: 'scheduled' }));
      await repo.create(newWo({ status: 'done' }));
      await repo.create(newWo({ status: 'cancelled' }));

      const page1 = await repo.list({ limit: 1, offset: 0 });
      const page2 = await repo.list({ limit: 1, offset: 1 });

      expect(page1.summary).toEqual(page2.summary);
      expect(page1.summary.total).toBe(3);
    });
  });

  it('create: round-trips ticketId when the WO is linked to a ticket (P3.B.4)', async () => {
    const ticketId = '00000000-0000-0000-0000-0000000000e1';
    const wo = await repo.create(newWo({ type: 'repair', ticketId }));
    expect(wo.ticketId).toBe(ticketId);

    const found = await repo.findById(wo.id);
    expect(found?.ticketId).toBe(ticketId);
  });

  it('markDone flips status and rejects a missing order', async () => {
    const created = await repo.create(newWo());
    const done = await repo.markDone(created.id);
    expect(done.status).toBe('done');
    await expect(repo.markDone('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });

  // ---- field-completion evidence (P3.B.3) -----------------------------------

  it('markDone writes and returns the field-completion evidence columns', async () => {
    const created = await repo.create(newWo());
    const completedAt = new Date('2026-07-06T08:00:00.000Z');

    const done = await repo.markDone(created.id, {
      scannedOnuSerial: 'ONU-SCAN-777',
      measuredRxPower: -18.5,
      photos: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
      signatureUrl: 'https://cdn.example.com/sig.png',
      gpsLat: -6.2,
      gpsLng: 106.8,
      completedAt,
      completedBy: 'Teknisi Budi',
    });

    expect(done.status).toBe('done');
    expect(done.scannedOnuSerial).toBe('ONU-SCAN-777');
    expect(done.measuredRxPower).toBe(-18.5);
    expect(done.photos).toEqual(['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg']);
    expect(done.signatureUrl).toBe('https://cdn.example.com/sig.png');
    expect(done.gpsLat).toBe(-6.2);
    expect(done.gpsLng).toBe(106.8);
    expect(done.completedAt?.toISOString()).toBe(completedAt.toISOString());
    expect(done.completedBy).toBe('Teknisi Budi');

    const found = await repo.findById(created.id);
    expect(found?.scannedOnuSerial).toBe('ONU-SCAN-777');
  });

  it('markDone with no completion evidence leaves the evidence columns null', async () => {
    const created = await repo.create(newWo());
    const done = await repo.markDone(created.id);
    expect(done.scannedOnuSerial).toBeNull();
    expect(done.measuredRxPower).toBeNull();
    expect(done.photos).toBeNull();
    expect(done.completionNotes).toBeNull();
    expect(done.completedAt).toBeNull();
    expect(done.completedBy).toBeNull();
  });

  // completion_notes (0045) — free-text "Catatan" field entered by the
  // technician on completion.
  it('markDone persists the completion note and reads it back on findById', async () => {
    const created = await repo.create(newWo());

    const done = await repo.markDone(created.id, {
      completionNotes: 'ONT dipasang di lantai 2, sinyal stabil.',
      completedAt: new Date('2026-07-06T08:00:00.000Z'),
      completedBy: 'Teknisi Budi',
    });

    expect(done.completionNotes).toBe('ONT dipasang di lantai 2, sinyal stabil.');

    const found = await repo.findById(created.id);
    expect(found?.completionNotes).toBe('ONT dipasang di lantai 2, sinyal stabil.');
  });

  it('markDone with no note leaves completionNotes null (nullable)', async () => {
    const created = await repo.create(newWo());
    const done = await repo.markDone(created.id, { completedBy: 'Teknisi Budi' });
    expect(done.completionNotes).toBeNull();
  });

  // ---- search (q) ----------------------------------------------------------

  it('search by code: returns matching order and total reflects filter', async () => {
    const a = await repo.create(newWo({ customerName: 'Alpha' }));
    await repo.create(newWo({ customerName: 'Beta' }));

    const result = await repo.list({ q: a.code, limit: 50, offset: 0 });

    expect(result.total).toBe(1);
    expect(result.items[0]?.code).toBe(a.code);
  });

  it('search by customerName: case-insensitive ILIKE matches substring', async () => {
    await repo.create(newWo({ customerName: 'Siti Rahayu' }));
    await repo.create(newWo({ customerName: 'Budi Santoso' }));

    const result = await repo.list({ q: 'siti', limit: 50, offset: 0 });

    expect(result.total).toBe(1);
    expect(result.items[0]?.customerName).toBe('Siti Rahayu');
  });

  it('search by customerName: total reflects filtered count (not total rows)', async () => {
    await repo.create(newWo({ customerName: 'Andi' }));
    await repo.create(newWo({ customerName: 'Andi Pratama' }));
    await repo.create(newWo({ customerName: 'Budi' }));

    const result = await repo.list({ q: 'andi', limit: 50, offset: 0 });

    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(2);
  });

  // ---- type filter ---------------------------------------------------------

  it('type filter: returns only orders of the requested type', async () => {
    await repo.create(newWo({ type: 'install' }));
    await repo.create(newWo({ type: 'repair' }));
    await repo.create(newWo({ type: 'repair' }));

    const result = await repo.list({ type: 'repair', limit: 50, offset: 0 });

    expect(result.total).toBe(2);
    for (const item of result.items) {
      expect(item.type).toBe('repair');
    }
  });

  // ---- technician filter ("Tugas saya", P3.B.1) ----------------------------

  it('technician filter: returns only that technician orders, exact match', async () => {
    await repo.create(newWo({ technician: 'Teknisi Andi' }));
    await repo.create(newWo({ technician: 'Teknisi Andi' }));
    await repo.create(newWo({ technician: 'Teknisi Budi' }));

    const result = await repo.list({ technician: 'Teknisi Andi', limit: 50, offset: 0 });

    expect(result.total).toBe(2);
    for (const item of result.items) {
      expect(item.technician).toBe('Teknisi Andi');
    }
  });

  it('type filter combined with status filter: ANDs the conditions', async () => {
    await repo.create(newWo({ type: 'install', status: 'scheduled' }));
    await repo.create(newWo({ type: 'install', status: 'done' }));
    await repo.create(newWo({ type: 'repair', status: 'scheduled' }));

    const result = await repo.list({
      type: 'install',
      status: 'scheduled',
      limit: 50,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.type).toBe('install');
    expect(result.items[0]?.status).toBe('scheduled');
  });

  // ---- sort ----------------------------------------------------------------

  it('sort by code asc: items returned in ascending code order', async () => {
    // Create several orders — their codes are assigned by sequence so they
    // are naturally ascending; we just assert the sort is respected.
    await repo.create(newWo());
    await repo.create(newWo());
    await repo.create(newWo());

    const result = await repo.list({ sort: 'code', order: 'asc', limit: 50, offset: 0 });

    expect(result.items.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < result.items.length; i++) {
      expect((result.items[i]?.code ?? '') >= (result.items[i - 1]?.code ?? '')).toBe(true);
    }
  });

  it('sort by code desc: items returned in descending code order', async () => {
    await repo.create(newWo());
    await repo.create(newWo());
    await repo.create(newWo());

    const result = await repo.list({ sort: 'code', order: 'desc', limit: 50, offset: 0 });

    expect(result.items.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < result.items.length; i++) {
      expect((result.items[i]?.code ?? '') <= (result.items[i - 1]?.code ?? '')).toBe(true);
    }
  });

  it('sort by scheduledAt asc: items ordered by scheduled date ascending', async () => {
    const early = new Date('2026-06-10T00:00:00.000Z');
    const late = new Date('2026-06-20T00:00:00.000Z');
    await repo.create(newWo({ scheduledAt: late }));
    await repo.create(newWo({ scheduledAt: early }));

    const result = await repo.list({ sort: 'scheduledAt', order: 'asc', limit: 50, offset: 0 });

    expect(result.items.length).toBe(2);
    expect(result.items[0]?.scheduledAt.getTime()).toBeLessThanOrEqual(
      result.items[1]?.scheduledAt.getTime() ?? Number.POSITIVE_INFINITY,
    );
  });

  it('sort by scheduledAt desc: most-future schedule first', async () => {
    const early = new Date('2026-06-10T00:00:00.000Z');
    const late = new Date('2026-06-20T00:00:00.000Z');
    await repo.create(newWo({ scheduledAt: early }));
    await repo.create(newWo({ scheduledAt: late }));

    const result = await repo.list({ sort: 'scheduledAt', order: 'desc', limit: 50, offset: 0 });

    expect(result.items.length).toBe(2);
    expect(result.items[0]?.scheduledAt.getTime()).toBeGreaterThanOrEqual(
      result.items[1]?.scheduledAt.getTime() ?? 0,
    );
  });

  it('unknown sort key falls back to default (createdAt DESC) without throwing', async () => {
    await repo.create(newWo());
    await repo.create(newWo());

    // Should not throw and should return rows.
    const result = await repo.list({
      sort: 'notARealColumn',
      order: 'asc',
      limit: 50,
      offset: 0,
    });

    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(2);
    // Default order is createdAt DESC: first item must be >= second in time.
    expect(result.items[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(
      result.items[1]?.createdAt.getTime() ?? 0,
    );
  });

  it('missing sort key falls back to default (createdAt DESC)', async () => {
    await repo.create(newWo());
    await repo.create(newWo());

    const result = await repo.list({ limit: 50, offset: 0 });

    expect(result.total).toBe(2);
    expect(result.items[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(
      result.items[1]?.createdAt.getTime() ?? 0,
    );
  });
});
