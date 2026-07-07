import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { resellers } from '../../infrastructure/database/schema/resellers.schema';
import { CustomersRepository } from './customers.repository';

/**
 * Real Postgres integration test for CustomersRepository. Requires Docker.
 * Schema is applied by hand (mirroring migration 0003) so the test runs
 * against any commit without first regenerating drizzle SQL.
 */
describe('CustomersRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: CustomersRepository;
  let planId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE plan_status AS ENUM ('active', 'archived');
      CREATE TABLE plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(80) NOT NULL,
        speed_mbps integer NOT NULL,
        price_monthly integer NOT NULL,
        status plan_status NOT NULL DEFAULT 'active',
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TYPE reseller_status AS ENUM ('active', 'inactive');
      CREATE TABLE resellers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(120) NOT NULL,
        area varchar(120) NOT NULL,
        balance integer NOT NULL DEFAULT 0,
        commission_pct real NOT NULL DEFAULT 0,
        status reseller_status NOT NULL DEFAULT 'active',
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE INDEX resellers_status_idx ON resellers (status);
      CREATE TYPE customer_status AS ENUM ('prospek', 'instalasi', 'aktif', 'isolir', 'berhenti');
      CREATE TYPE customer_hold_reason AS ENUM ('overdue', 'voluntary');
      CREATE SEQUENCE customer_no_seq START WITH 9001;
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        lat double precision, lng double precision, odp_id varchar(60), billing_anchor_day smallint,
        customer_no varchar(32) NOT NULL UNIQUE DEFAULT ('CUST-' || nextval('customer_no_seq')),
        full_name varchar(120) NOT NULL,
        phone varchar(20) NOT NULL,
        email varchar(255),
        user_id uuid UNIQUE,
        address varchar(255) NOT NULL,
        area_id uuid,
        area_name varchar(120),
        plan_id uuid NOT NULL REFERENCES plans(id),
        status customer_status NOT NULL DEFAULT 'prospek', hold_reason customer_hold_reason,
        outstanding integer NOT NULL DEFAULT 0,
        npwp varchar(40),
        ktp varchar(32),
        consent_at timestamptz(3),
        data_deletion_requested_at timestamptz(3),
        reseller_name varchar(120), reseller_id uuid REFERENCES resellers(id),
        connection jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE INDEX customers_status_idx ON customers (status);
      CREATE INDEX customers_full_name_idx ON customers (full_name);
      CREATE INDEX customers_plan_id_idx ON customers (plan_id);
      CREATE INDEX customers_reseller_id_idx ON customers (reseller_id);
    `);

    const [plan] = await db
      .insert(plans)
      .values({ name: 'Home 20', speedMbps: 20, priceMonthly: 200_000 })
      .returning();
    if (!plan) throw new Error('plan seed failed');
    planId = plan.id;

    repo = new CustomersRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(customers);
    await db.delete(resellers);
  });

  it('creates customers with sequential customer_no and joins the plan name', async () => {
    const a = await repo.create({
      fullName: 'Budi',
      phone: '0811',
      address: 'Jl. A',
      planId,
    });
    const b = await repo.create({
      fullName: 'Ani',
      phone: '0812',
      address: 'Jl. B',
      planId,
    });

    expect(a.customerNo).toMatch(/^CUST-\d+$/);
    expect(Number(b.customerNo.split('-')[1])).toBe(Number(a.customerNo.split('-')[1]) + 1);
    expect(a.planName).toBe('Home 20');
    expect(a.status).toBe('prospek');
    expect(a.outstanding).toBe(0);
  });

  it('lists with status + q filters, alphabetical order and a real total', async () => {
    await repo.create({
      fullName: 'Zaki',
      phone: '0810',
      address: 'Jl. Z',
      planId,
    });
    const ani = await repo.create({
      fullName: 'Ani',
      phone: '0812',
      address: 'Jl. B',
      planId,
    });
    await repo.setStatus(ani.id, 'aktif', {});

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.items.map((c) => c.fullName)).toEqual(['Ani', 'Zaki']);

    const active = await repo.list({ status: 'aktif', limit: 50, offset: 0 });
    expect(active.total).toBe(1);
    expect(active.items[0]?.fullName).toBe('Ani');

    const search = await repo.list({ q: 'zak', limit: 50, offset: 0 });
    expect(search.total).toBe(1);
    expect(search.items[0]?.fullName).toBe('Zaki');
  });

  // ADR-0011 parity: billingAnchorDay is an item-level field the FE customer
  // schema requires — it must survive list()'s column projection (never
  // dropped), null when unset.
  it('list() returns billingAnchorDay per item, null when unset', async () => {
    await repo.create({ fullName: 'Zaki', phone: '0810', address: 'Jl. Z', planId });
    await repo.create({
      fullName: 'Ani',
      phone: '0812',
      address: 'Jl. B',
      planId,
      billingAnchorDay: 15,
    });

    const result = await repo.list({ limit: 50, offset: 0 });
    const ani = result.items.find((c) => c.fullName === 'Ani');
    const zaki = result.items.find((c) => c.fullName === 'Zaki');
    expect(ani?.billingAnchorDay).toBe(15);
    expect(zaki?.billingAnchorDay).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // list — full-set (scope-wide) summary aggregate (T1, FE contract parity)
  // ---------------------------------------------------------------------------

  describe('list — summary aggregate', () => {
    it('summary.byStatus + outstanding cover every customer regardless of the status filter', async () => {
      const a = await repo.create({ fullName: 'Aktif1', phone: '08', address: 'Jl', planId });
      await repo.setStatus(a.id, 'aktif', {});
      const a2 = await repo.create({ fullName: 'Aktif2', phone: '08', address: 'Jl', planId });
      await repo.setStatus(a2.id, 'aktif', {});
      const i = await repo.create({ fullName: 'Isolir1', phone: '08', address: 'Jl', planId });
      await repo.setStatus(i.id, 'isolir', {});
      await db.update(customers).set({ outstanding: 150_000 }).where(eq(customers.id, i.id));
      await repo.create({ fullName: 'Prospek1', phone: '08', address: 'Jl', planId });

      // Filtered view: only aktif
      const result = await repo.list({ status: 'aktif', limit: 50, offset: 0 });
      expect(result.total).toBe(2); // filtered total
      expect(result.items).toHaveLength(2);

      // Full-set summary — must still reflect ALL 4 customers across statuses.
      expect(result.summary).toEqual({
        total: 4,
        outstanding: 150_000,
        byStatus: { prospek: 1, instalasi: 0, aktif: 2, isolir: 1, berhenti: 0 },
      });
    });

    it('summary does not change when q matches only some customers', async () => {
      await repo.create({ fullName: 'Zaki', phone: '0810', address: 'Jl. Z', planId });
      const ani = await repo.create({ fullName: 'Ani', phone: '0812', address: 'Jl. B', planId });
      await repo.setStatus(ani.id, 'aktif', {});

      const filtered = await repo.list({ q: 'zak', limit: 50, offset: 0 });
      expect(filtered.total).toBe(1); // filtered total

      const all = await repo.list({ limit: 50, offset: 0 });

      // Summary must be identical — q doesn't affect it either.
      expect(filtered.summary).toEqual(all.summary);
      expect(filtered.summary).toEqual({
        total: 2,
        outstanding: 0,
        byStatus: { prospek: 1, instalasi: 0, aktif: 1, isolir: 0, berhenti: 0 },
      });
    });

    it('area scope narrows the summary — unassigned customers always count too', async () => {
      await repo.create({
        fullName: 'Jepara1',
        phone: '08',
        address: 'Jl',
        planId,
        areaName: 'Jepara',
      });
      await repo.create({
        fullName: 'Tahunan1',
        phone: '08',
        address: 'Jl',
        planId,
        areaName: 'Tahunan',
      });
      await repo.create({ fullName: 'Unassigned1', phone: '08', address: 'Jl', planId });

      // Scoped to Jepara only — but the unassigned customer is still in scope.
      const scoped = await repo.list({ area: ['Jepara'], limit: 50, offset: 0 });
      expect(scoped.summary.total).toBe(2); // Jepara1 + Unassigned1
      expect(scoped.items.map((c) => c.fullName).sort()).toEqual(['Jepara1', 'Unassigned1']);

      // Unscoped — every customer is in the summary.
      const all = await repo.list({ limit: 50, offset: 0 });
      expect(all.summary.total).toBe(3);
    });

    it('resellerId scope narrows the summary to that reseller only', async () => {
      const [resellerA] = await db
        .insert(resellers)
        .values({ name: 'Loket Andi', area: 'Jepara' })
        .returning();
      const [resellerB] = await db
        .insert(resellers)
        .values({ name: 'Loket Budi', area: 'Kudus' })
        .returning();
      if (!resellerA || !resellerB) throw new Error('reseller seed failed');

      await repo.create({
        fullName: 'C1',
        phone: '08',
        address: 'Jl',
        planId,
        resellerId: resellerA.id,
      });
      await repo.create({
        fullName: 'C2',
        phone: '08',
        address: 'Jl',
        planId,
        resellerId: resellerB.id,
      });

      const scoped = await repo.list({ resellerId: resellerA.id, limit: 50, offset: 0 });
      expect(scoped.summary.total).toBe(1);
      expect(scoped.items[0]?.fullName).toBe('C1');
    });

    it('zero-fills every status key and outstanding when the scope is empty', async () => {
      const result = await repo.list({ limit: 50, offset: 0 });
      expect(result.summary).toEqual({
        total: 0,
        outstanding: 0,
        byStatus: { prospek: 0, instalasi: 0, aktif: 0, isolir: 0, berhenti: 0 },
      });
    });

    it('limit/offset paging does not affect the summary', async () => {
      await repo.create({ fullName: 'A', phone: '08', address: 'Jl', planId });
      await repo.create({ fullName: 'B', phone: '08', address: 'Jl', planId });
      await repo.create({ fullName: 'C', phone: '08', address: 'Jl', planId });

      const page1 = await repo.list({ limit: 1, offset: 0 });
      const page2 = await repo.list({ limit: 1, offset: 1 });

      expect(page1.summary).toEqual(page2.summary);
      expect(page1.summary.total).toBe(3);
    });
  });

  it('paginates with limit/offset while reporting the full total', async () => {
    for (const n of ['A', 'B', 'C']) {
      await repo.create({ fullName: n, phone: '0810', address: 'Jl.', planId });
    }
    const page = await repo.list({ limit: 2, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.items.map((c) => c.fullName)).toEqual(['A', 'B']);
  });

  it('updates profile fields and bumps updated_at', async () => {
    const created = await repo.create({
      fullName: 'Budi',
      phone: '0811',
      address: 'Jl. A',
      planId,
    });
    const updated = await repo.updateProfile(created.id, {
      phone: '0899',
      email: 'budi@isp.id',
    });
    expect(updated.phone).toBe('0899');
    expect(updated.email).toBe('budi@isp.id');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('activate clears outstanding while isolate keeps it', async () => {
    const created = await repo.create({
      fullName: 'Budi',
      phone: '0811',
      address: 'Jl. A',
      planId,
    });
    // Give the customer a debt directly (no balance API in this module).
    await db.update(customers).set({ outstanding: 150_000 }).where(eq(customers.id, created.id));

    const isolated = await repo.setStatus(created.id, 'isolir', {});
    expect(isolated.status).toBe('isolir');
    expect(isolated.outstanding).toBe(150_000);
    // Default isolir reason is punitive (P3.A.3).
    expect(isolated.holdReason).toBe('overdue');

    const activated = await repo.setStatus(created.id, 'aktif', {
      clearOutstanding: true,
    });
    expect(activated.status).toBe('aktif');
    expect(activated.outstanding).toBe(0);
    // Reactivation clears the hold reason.
    expect(activated.holdReason).toBeNull();
  });

  it('records the hold reason: voluntary (cuti) vs overdue (P3.A.3)', async () => {
    const created = await repo.create({ fullName: 'Ana', phone: '08', address: 'Jl', planId });

    const cuti = await repo.setStatus(created.id, 'isolir', { holdReason: 'voluntary' });
    expect(cuti.status).toBe('isolir');
    expect(cuti.holdReason).toBe('voluntary');

    const overdue = await repo.setStatus(created.id, 'isolir', { holdReason: 'overdue' });
    expect(overdue.holdReason).toBe('overdue');
  });

  // ---------------------------------------------------------------------------
  // KYC-safe projection (ADR-0010 amendment / ADR-0015, SEC-4): the mitra
  // read path replaces npwp/ktp with a real SQL NULL rather than reading the
  // stored column value.
  // ---------------------------------------------------------------------------

  describe('KYC-safe projection', () => {
    it('findById(excludeKyc: true) returns null npwp/ktp even though the row has values', async () => {
      const created = await repo.create({
        fullName: 'Budi',
        phone: '0811',
        address: 'Jl. A',
        planId,
      });
      await repo.updateKyc(created.id, { ktp: '3201abc', npwp: '01.234.567.8-901.000' });

      const full = await repo.findById(created.id);
      expect(full?.ktp).toBe('3201abc');
      expect(full?.npwp).toBe('01.234.567.8-901.000');

      const safe = await repo.findById(created.id, { excludeKyc: true });
      expect(safe?.ktp).toBeNull();
      expect(safe?.npwp).toBeNull();
      // Every other field is unaffected by the projection.
      expect(safe?.fullName).toBe('Budi');
    });

    it('list({ excludeKyc: true }) returns null npwp/ktp for every row', async () => {
      const created = await repo.create({
        fullName: 'Ani',
        phone: '0812',
        address: 'Jl. B',
        planId,
      });
      await repo.updateKyc(created.id, { ktp: '3202def', npwp: null });

      const safe = await repo.list({ excludeKyc: true, limit: 50, offset: 0 });
      expect(safe.items).toHaveLength(1);
      expect(safe.items[0]?.ktp).toBeNull();
      expect(safe.items[0]?.fullName).toBe('Ani');

      const full = await repo.list({ limit: 50, offset: 0 });
      expect(full.items[0]?.ktp).toBe('3202def');
    });
  });

  it('records consent and KYC', async () => {
    const created = await repo.create({
      fullName: 'Budi',
      phone: '0811',
      address: 'Jl. A',
      planId,
    });
    const consented = await repo.recordConsent(created.id);
    expect(consented.consentAt).toBeInstanceOf(Date);

    const kyc = await repo.updateKyc(created.id, {
      ktp: '3201abc',
      npwp: null,
    });
    expect(kyc.ktp).toBe('3201abc');
    expect(kyc.npwp).toBeNull();
  });

  it('round-trips the onboarding map pin (lat/lng)', async () => {
    const created = await repo.create({
      fullName: 'Geo',
      phone: '0812',
      address: 'Jl. Peta',
      planId,
      lat: -6.5900123,
      lng: 110.6700456,
    });
    expect(created.lat).toBeCloseTo(-6.5900123);
    expect(created.lng).toBeCloseTo(110.6700456);

    const read = await repo.findById(created.id);
    expect(read?.lat).toBeCloseTo(-6.5900123);
    expect(read?.lng).toBeCloseTo(110.6700456);
  });

  it('requestDataDeletion marks the row, and missing ids reject', async () => {
    const created = await repo.create({
      fullName: 'Budi',
      phone: '0811',
      address: 'Jl. A',
      planId,
    });
    await expect(repo.requestDataDeletion(created.id)).resolves.toBeUndefined();

    await expect(
      repo.requestDataDeletion('00000000-0000-0000-0000-0000000000ff'),
    ).rejects.toThrow();
    await expect(
      repo.setStatus('00000000-0000-0000-0000-0000000000ff', 'aktif', {}),
    ).rejects.toThrow();
  });

  it('resolves a customer strictly by email (portal fails closed)', async () => {
    await repo.create({
      fullName: 'Zaki',
      phone: '0813',
      email: 'zaki@example.com',
      address: 'Jl. Z',
      planId,
    });
    await repo.create({ fullName: 'Ani', phone: '0812', address: 'Jl. A', planId });

    const byEmail = await repo.findByEmail('zaki@example.com');
    expect(byEmail?.fullName).toBe('Zaki');
    expect(byEmail?.planName).toBe('Home 20');
    expect(await repo.findByEmail('nobody@example.com')).toBeNull();
  });

  it('aggregates status counts, new-since and at-risk for the dashboard', async () => {
    const a = await repo.create({ fullName: 'Aktif', phone: '08', address: 'Jl', planId });
    await repo.setStatus(a.id, 'aktif', {});
    const i = await repo.create({ fullName: 'Isolir', phone: '08', address: 'Jl', planId });
    await repo.setStatus(i.id, 'isolir', {});
    // A prospek carrying a balance — at risk despite not being isolated.
    const p = await repo.create({ fullName: 'Prospek', phone: '08', address: 'Jl', planId });
    await db.update(customers).set({ outstanding: 50_000 }).where(eq(customers.id, p.id));
    const b = await repo.create({ fullName: 'Berhenti', phone: '08', address: 'Jl', planId });
    await repo.setStatus(b.id, 'berhenti', {});

    expect(await repo.countByStatus()).toEqual({
      prospek: 1,
      instalasi: 0,
      aktif: 1,
      isolir: 1,
      berhenti: 1,
    });
    // All four were just created; a far-future cutoff sees none.
    expect(await repo.countCreatedSince(new Date('2000-01-01T00:00:00.000Z'))).toBe(4);
    expect(await repo.countCreatedSince(new Date('2999-01-01T00:00:00.000Z'))).toBe(0);
    // At risk = isolir OR outstanding > 0 -> the isolir + the prospek-with-debt.
    expect(await repo.countAtRisk()).toBe(2);
  });

  it('groups new and churned subscribers by month, honoring the since bound', async () => {
    await db.insert(customers).values([
      // Added: Feb x2 (the churned rows, created earlier), Mar x2, May x1.
      mk('Mar1', { createdAt: new Date('2026-03-10T00:00:00.000Z') }),
      mk('Mar2', { createdAt: new Date('2026-03-20T00:00:00.000Z') }),
      mk('May1', { createdAt: new Date('2026-05-05T00:00:00.000Z') }),
      // Churned: berhenti updated in Apr and Jun.
      mk('AprC', {
        status: 'berhenti',
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        updatedAt: new Date('2026-04-01T00:00:00.000Z'),
      }),
      mk('JunC', {
        status: 'berhenti',
        createdAt: new Date('2026-02-02T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
      // Before the window — excluded by the since bound.
      mk('Old', { createdAt: new Date('2025-12-15T00:00:00.000Z') }),
    ]);

    const since = new Date('2026-01-01T00:00:00.000Z');
    const byMonth = (rows: Array<{ month: string; count: number }>) =>
      [...rows].sort((x, y) => x.month.localeCompare(y.month));

    expect(byMonth(await repo.countCreatedByMonth(since))).toEqual([
      { month: '2026-02', count: 2 },
      { month: '2026-03', count: 2 },
      { month: '2026-05', count: 1 },
    ]);
    expect(byMonth(await repo.countChurnedByMonth(since))).toEqual([
      { month: '2026-04', count: 1 },
      { month: '2026-06', count: 1 },
    ]);
  });

  // -----------------------------------------------------------------------
  // resellerName derivation (M1 prod-only fix): resellerName is never a
  // stored column write — it is joined from resellers.name at read time, so
  // it can never drift when a reseller is renamed.
  // -----------------------------------------------------------------------

  it('derives resellerName via LEFT JOIN when a customer has a resellerId', async () => {
    const [reseller] = await db
      .insert(resellers)
      .values({ name: 'Loket Andi', area: 'Jepara' })
      .returning();
    if (!reseller) throw new Error('reseller seed failed');

    const created = await repo.create({
      fullName: 'Budi',
      phone: '0811',
      address: 'Jl. A',
      planId,
      resellerId: reseller.id,
    });
    expect(created.resellerName).toBe('Loket Andi');

    const read = await repo.findById(created.id);
    expect(read?.resellerName).toBe('Loket Andi');

    // Renaming the reseller is reflected immediately — proves the name is
    // derived at read time, not a stale denormalized copy.
    await db
      .update(resellers)
      .set({ name: 'Loket Andi Baru' })
      .where(eq(resellers.id, reseller.id));
    const renamed = await repo.findById(created.id);
    expect(renamed?.resellerName).toBe('Loket Andi Baru');
  });

  it('returns resellerName: null for a customer with no reseller (LEFT JOIN, not INNER)', async () => {
    const created = await repo.create({
      fullName: 'Ani',
      phone: '0812',
      address: 'Jl. B',
      planId,
    });
    expect(created.resellerName).toBeNull();

    const read = await repo.findById(created.id);
    expect(read?.resellerName).toBeNull();
  });

  it('countByResellerId and countsByResellerId key off the FK, not the name', async () => {
    const [resellerA] = await db
      .insert(resellers)
      .values({ name: 'Loket Andi', area: 'Jepara' })
      .returning();
    const [resellerB] = await db
      .insert(resellers)
      .values({ name: 'Loket Budi', area: 'Kudus' })
      .returning();
    if (!resellerA || !resellerB) throw new Error('reseller seed failed');

    await repo.create({
      fullName: 'C1',
      phone: '08',
      address: 'Jl',
      planId,
      resellerId: resellerA.id,
    });
    const onboarded = await repo.create({
      fullName: 'C2',
      phone: '08',
      address: 'Jl',
      planId,
      resellerId: resellerA.id,
    });
    // An onboarded/instalasi customer must still be counted for the reseller.
    await repo.setStatus(onboarded.id, 'instalasi', {});
    await repo.create({
      fullName: 'C3',
      phone: '08',
      address: 'Jl',
      planId,
      resellerId: resellerB.id,
    });
    await repo.create({ fullName: 'C4', phone: '08', address: 'Jl', planId }); // unlinked

    expect(await repo.countByResellerId(resellerA.id)).toBe(2);
    expect(await repo.countByResellerId(resellerB.id)).toBe(1);

    const counts = await repo.countsByResellerId();
    const byId = new Map(counts.map((c) => [c.resellerId, c.count]));
    expect(byId.get(resellerA.id)).toBe(2);
    expect(byId.get(resellerB.id)).toBe(1);
  });

  // Insert helper for the month-grouping aggregates (explicit timestamps).
  function mk(
    fullName: string,
    over: Partial<typeof customers.$inferInsert> = {},
  ): typeof customers.$inferInsert {
    return { fullName, phone: '08', address: 'Jl', planId, ...over };
  }
});
