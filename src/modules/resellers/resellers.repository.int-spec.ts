import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import {
  type ResellerLedgerEntry,
  resellerLedger,
  resellers,
} from '../../infrastructure/database/schema/resellers.schema';
import { ResellersRepository } from './resellers.repository';

/**
 * Real Postgres integration test for ResellersRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0012).
 */
describe('ResellersRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: ResellersRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE reseller_status AS ENUM ('active', 'inactive');
      CREATE TYPE reseller_ledger_type AS ENUM ('topup', 'commission', 'deduction', 'withdrawal');
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
      CREATE TABLE reseller_ledger (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        reseller_id uuid NOT NULL REFERENCES resellers(id),
        type reseller_ledger_type NOT NULL,
        amount integer NOT NULL,
        note varchar(200) NOT NULL DEFAULT '',
        balance_after integer NOT NULL,
        at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    repo = new ResellersRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(resellerLedger);
    await db.delete(resellers);
  });

  async function seed(over: Partial<typeof resellers.$inferInsert> = {}) {
    const [row] = await db
      .insert(resellers)
      .values({
        name: 'Loket Andi',
        area: 'Jepara',
        balance: 1_000_000,
        commissionPct: 0.05,
        ...over,
      })
      .returning();
    if (!row) throw new Error('seed failed');
    return row;
  }

  it('lists by status with a real total and limit/offset', async () => {
    await seed();
    await seed({ name: 'Agen Budi', status: 'inactive' });

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(2);
    const active = await repo.list({ status: 'active', limit: 50, offset: 0 });
    expect(active.total).toBe(1);
  });

  describe('search (q)', () => {
    it('matches by name substring case-insensitively', async () => {
      await seed({ name: 'Loket Andi', area: 'Jepara' });
      await seed({ name: 'Agen Budi', area: 'Kudus' });
      await seed({ name: 'Mitra Citra', area: 'Semarang' });

      const result = await repo.list({ q: 'andi', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.name).toBe('Loket Andi');
    });

    it('matches by area substring case-insensitively', async () => {
      await seed({ name: 'Loket Andi', area: 'Jepara Utara' });
      await seed({ name: 'Agen Budi', area: 'Kudus' });

      const result = await repo.list({ q: 'jepara', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.area).toBe('Jepara Utara');
    });

    it('total reflects q filter, not the full table count', async () => {
      await seed({ name: 'MATCH-Loket', area: 'Jepara' });
      await seed({ name: 'MATCH-Agen', area: 'Kudus' });
      await seed({ name: 'Other-Mitra', area: 'Semarang' });

      const result = await repo.list({ q: 'MATCH', limit: 50, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
    });

    it('returns empty result when q matches nothing', async () => {
      await seed({ name: 'Loket Andi', area: 'Jepara' });

      const result = await repo.list({ q: 'doesnotexist', limit: 50, offset: 0 });
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });

  describe('sort', () => {
    it('sorts by name ascending', async () => {
      await seed({ name: 'Citra Mitra', area: 'Semarang' });
      await seed({ name: 'Andi Loket', area: 'Jepara' });
      await seed({ name: 'Budi Agen', area: 'Kudus' });

      const result = await repo.list({ sort: 'name', order: 'asc', limit: 50, offset: 0 });
      expect(result.items.map((r) => r.name)).toEqual(['Andi Loket', 'Budi Agen', 'Citra Mitra']);
    });

    it('sorts by name descending', async () => {
      await seed({ name: 'Citra Mitra', area: 'Semarang' });
      await seed({ name: 'Andi Loket', area: 'Jepara' });
      await seed({ name: 'Budi Agen', area: 'Kudus' });

      const result = await repo.list({ sort: 'name', order: 'desc', limit: 50, offset: 0 });
      expect(result.items.map((r) => r.name)).toEqual(['Citra Mitra', 'Budi Agen', 'Andi Loket']);
    });

    it('sorts by balance ascending', async () => {
      await seed({ name: 'Medium', balance: 500_000 });
      await seed({ name: 'High', balance: 1_000_000 });
      await seed({ name: 'Low', balance: 100_000 });

      const result = await repo.list({ sort: 'balance', order: 'asc', limit: 50, offset: 0 });
      expect(result.items.map((r) => r.balance)).toEqual([100_000, 500_000, 1_000_000]);
    });

    it('falls back to createdAt desc when sort key is unknown', async () => {
      // Insert in order: X, Y, Z — default sort is createdAt desc so Z is first
      const x = await seed({ name: 'X-Reseller', area: 'Jepara' });
      const y = await seed({ name: 'Y-Reseller', area: 'Kudus' });
      const z = await seed({ name: 'Z-Reseller', area: 'Semarang' });

      const result = await repo.list({ sort: 'notAColumn', order: 'asc', limit: 50, offset: 0 });
      // Default: createdAt desc → Z, Y, X
      expect(result.items.map((r) => r.id)).toEqual([z.id, y.id, x.id]);
    });
  });

  it('updates fields and rejects a missing reseller', async () => {
    const r = await seed();
    const updated = await repo.update(r.id, { commissionPct: 0.1, status: 'inactive' });
    expect(updated.commissionPct).toBeCloseTo(0.1);
    expect(updated.status).toBe('inactive');
    await expect(
      repo.update('00000000-0000-0000-0000-0000000000ff', { area: 'X' }),
    ).rejects.toThrow();
  });

  it('credits and debits the balance atomically with a running ledger', async () => {
    const r = await seed({ balance: 0 });
    const afterTopup = await repo.addLedgerEntry(r.id, {
      type: 'topup',
      amount: 1_000_000,
      note: 'Setoran',
    });
    expect(afterTopup.balance).toBe(1_000_000);

    const afterWithdraw = await repo.addLedgerEntry(r.id, {
      type: 'withdrawal',
      amount: 400_000,
      note: 'Tarik',
    });
    expect(afterWithdraw.balance).toBe(600_000);

    const ledger = await repo.listLedger(r.id, { limit: 50, offset: 0 });
    expect(ledger.total).toBe(2);
    // newest first; balanceAfter tracks the running total
    expect(ledger.items[0]?.amount).toBe(-400_000);
    expect(ledger.items[0]?.balanceAfter).toBe(600_000);
  });

  it('rejects a debit that would overdraw the balance (422) and does not write', async () => {
    const r = await seed({ balance: 100_000 });
    await expect(
      repo.addLedgerEntry(r.id, { type: 'withdrawal', amount: 500_000, note: 'Tarik' }),
    ).rejects.toThrow();
    // balance unchanged, no ledger row
    expect((await repo.findById(r.id))?.balance).toBe(100_000);
    expect((await repo.listLedger(r.id, { limit: 50, offset: 0 })).total).toBe(0);
  });

  describe('listLedger — pagination, search, sort', () => {
    async function seedLedger(
      resellerId: string,
      entries: Array<{
        type: ResellerLedgerEntry['type'];
        amount: number;
        note: string;
        balanceAfter: number;
      }>,
    ) {
      for (const entry of entries) {
        await db.insert(resellerLedger).values({ resellerId, ...entry });
      }
    }

    it('returns {items, total} for a reseller; total equals full count when no q', async () => {
      const r = await seed({ balance: 0 });
      await seedLedger(r.id, [
        { type: 'topup', amount: 100_000, note: 'Setoran A', balanceAfter: 100_000 },
        { type: 'commission', amount: 50_000, note: 'Komisi B', balanceAfter: 150_000 },
        { type: 'withdrawal', amount: -30_000, note: 'Tarik C', balanceAfter: 120_000 },
      ]);

      const result = await repo.listLedger(r.id, { limit: 50, offset: 0 });
      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(3);
    });

    it('q filters by note substring case-insensitively; total reflects filtered count', async () => {
      const r = await seed({ balance: 0 });
      await seedLedger(r.id, [
        { type: 'topup', amount: 100_000, note: 'Setoran Pagi', balanceAfter: 100_000 },
        { type: 'topup', amount: 200_000, note: 'setoran malam', balanceAfter: 300_000 },
        { type: 'commission', amount: 50_000, note: 'Komisi Bulan', balanceAfter: 350_000 },
      ]);

      const result = await repo.listLedger(r.id, { q: 'setoran', limit: 50, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      for (const item of result.items) {
        expect(item.note.toLowerCase()).toContain('setoran');
      }
    });

    it('q returns empty result when note matches nothing', async () => {
      const r = await seed({ balance: 0 });
      await seedLedger(r.id, [
        { type: 'topup', amount: 100_000, note: 'Setoran Pagi', balanceAfter: 100_000 },
      ]);

      const result = await repo.listLedger(r.id, { q: 'tidakada', limit: 50, offset: 0 });
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });

    it('sorts by amount ascending', async () => {
      const r = await seed({ balance: 0 });
      await seedLedger(r.id, [
        { type: 'topup', amount: 300_000, note: 'C', balanceAfter: 300_000 },
        { type: 'topup', amount: 100_000, note: 'A', balanceAfter: 100_000 },
        { type: 'topup', amount: 200_000, note: 'B', balanceAfter: 200_000 },
      ]);

      const result = await repo.listLedger(r.id, {
        sort: 'amount',
        order: 'asc',
        limit: 50,
        offset: 0,
      });
      const amounts = result.items.map((i) => i.amount);
      expect(amounts).toEqual([100_000, 200_000, 300_000]);
    });

    it('sorts by amount descending', async () => {
      const r = await seed({ balance: 0 });
      await seedLedger(r.id, [
        { type: 'topup', amount: 300_000, note: 'C', balanceAfter: 300_000 },
        { type: 'topup', amount: 100_000, note: 'A', balanceAfter: 100_000 },
        { type: 'topup', amount: 200_000, note: 'B', balanceAfter: 200_000 },
      ]);

      const result = await repo.listLedger(r.id, {
        sort: 'amount',
        order: 'desc',
        limit: 50,
        offset: 0,
      });
      const amounts = result.items.map((i) => i.amount);
      expect(amounts).toEqual([300_000, 200_000, 100_000]);
    });

    it('sorts by balanceAfter ascending', async () => {
      const r = await seed({ balance: 0 });
      await seedLedger(r.id, [
        { type: 'topup', amount: 300_000, note: 'C', balanceAfter: 500_000 },
        { type: 'topup', amount: 100_000, note: 'A', balanceAfter: 100_000 },
        { type: 'topup', amount: 200_000, note: 'B', balanceAfter: 300_000 },
      ]);

      const result = await repo.listLedger(r.id, {
        sort: 'balanceAfter',
        order: 'asc',
        limit: 50,
        offset: 0,
      });
      const balances = result.items.map((i) => i.balanceAfter);
      expect(balances).toEqual([100_000, 300_000, 500_000]);
    });

    it('sorts by type ascending (enum definition order: topup < commission < withdrawal)', async () => {
      const r = await seed({ balance: 0 });
      await seedLedger(r.id, [
        { type: 'withdrawal', amount: -100_000, note: 'W', balanceAfter: 900_000 },
        { type: 'commission', amount: 50_000, note: 'C', balanceAfter: 950_000 },
        { type: 'topup', amount: 1_000_000, note: 'T', balanceAfter: 1_000_000 },
      ]);

      const result = await repo.listLedger(r.id, {
        sort: 'type',
        order: 'asc',
        limit: 50,
        offset: 0,
      });
      const types = result.items.map((i) => i.type);
      // Postgres ENUM sorts by definition order: topup(0) < commission(1) < withdrawal(3)
      expect(types).toEqual(['topup', 'commission', 'withdrawal']);
    });

    it('sorts by at descending (newest first — default)', async () => {
      const r = await seed({ balance: 0 });
      // Insert with explicit at timestamps to guarantee order
      const base = new Date('2026-01-01T00:00:00Z');
      await db.insert(resellerLedger).values({
        resellerId: r.id,
        type: 'topup',
        amount: 1,
        note: 'oldest',
        balanceAfter: 1,
        at: new Date(base.getTime()),
      });
      await db.insert(resellerLedger).values({
        resellerId: r.id,
        type: 'topup',
        amount: 2,
        note: 'middle',
        balanceAfter: 2,
        at: new Date(base.getTime() + 1000),
      });
      await db.insert(resellerLedger).values({
        resellerId: r.id,
        type: 'topup',
        amount: 3,
        note: 'newest',
        balanceAfter: 3,
        at: new Date(base.getTime() + 2000),
      });

      const result = await repo.listLedger(r.id, {
        sort: 'at',
        order: 'desc',
        limit: 50,
        offset: 0,
      });
      expect(result.items.map((i) => i.note)).toEqual(['newest', 'middle', 'oldest']);
    });

    it('unknown sort key falls back to at desc without throwing', async () => {
      const r = await seed({ balance: 0 });
      const base = new Date('2026-01-01T00:00:00Z');
      await db.insert(resellerLedger).values({
        resellerId: r.id,
        type: 'topup',
        amount: 1,
        note: 'oldest',
        balanceAfter: 1,
        at: new Date(base.getTime()),
      });
      await db.insert(resellerLedger).values({
        resellerId: r.id,
        type: 'topup',
        amount: 2,
        note: 'newest',
        balanceAfter: 2,
        at: new Date(base.getTime() + 1000),
      });

      const result = await repo.listLedger(r.id, {
        sort: 'notAColumn',
        order: 'asc',
        limit: 50,
        offset: 0,
      });
      // default: at desc → newest first
      expect(result.items[0]?.note).toBe('newest');
    });

    it('limit=1 returns 1 item but total stays the full count', async () => {
      const r = await seed({ balance: 0 });
      await seedLedger(r.id, [
        { type: 'topup', amount: 100_000, note: 'A', balanceAfter: 100_000 },
        { type: 'topup', amount: 200_000, note: 'B', balanceAfter: 300_000 },
        { type: 'topup', amount: 300_000, note: 'C', balanceAfter: 600_000 },
      ]);

      const result = await repo.listLedger(r.id, { limit: 1, offset: 0 });
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(3);
    });

    it('offset skips rows while total stays the full count', async () => {
      const r = await seed({ balance: 0 });
      const base = new Date('2026-01-01T00:00:00Z');
      await db.insert(resellerLedger).values({
        resellerId: r.id,
        type: 'topup',
        amount: 1,
        note: 'first',
        balanceAfter: 1,
        at: new Date(base.getTime() + 2000),
      });
      await db.insert(resellerLedger).values({
        resellerId: r.id,
        type: 'topup',
        amount: 2,
        note: 'second',
        balanceAfter: 2,
        at: new Date(base.getTime() + 1000),
      });
      await db.insert(resellerLedger).values({
        resellerId: r.id,
        type: 'topup',
        amount: 3,
        note: 'third',
        balanceAfter: 3,
        at: new Date(base.getTime()),
      });

      // Default at desc: first, second, third → offset=1 skips "first"
      const result = await repo.listLedger(r.id, { limit: 50, offset: 1 });
      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.note).toBe('second');
    });
  });
});
