import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { resellerLedger, resellers } from '../../infrastructure/database/schema/resellers.schema';
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

    const ledger = await repo.listLedger(r.id);
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
    expect((await repo.listLedger(r.id)).total).toBe(0);
  });
});
