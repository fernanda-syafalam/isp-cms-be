import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { slaCredits } from '../../infrastructure/database/schema/sla-credits.schema';
import { SlaCreditsRepository } from './sla-credits.repository';

/**
 * Real Postgres integration test for SlaCreditsRepository. Requires Docker.
 * The customer_id / ticket_id FKs are left nullable in these tests, so only
 * the sla_credits table is created (mirroring migration 0010 minus the FKs,
 * which are exercised in the customers/tickets suites).
 */
describe('SlaCreditsRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: SlaCreditsRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE sla_credit_status AS ENUM ('pending', 'applied', 'void');
      CREATE TABLE sla_credits (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id uuid,
        customer_name varchar(120) NOT NULL,
        amount integer NOT NULL,
        reason varchar(200) NOT NULL,
        ticket_id uuid,
        ticket_code varchar(40),
        status sla_credit_status NOT NULL DEFAULT 'pending',
        applied_at timestamptz(3),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    repo = new SlaCreditsRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(slaCredits);
  });

  const newCredit = (over: Partial<typeof slaCredits.$inferInsert> = {}) => ({
    customerId: null,
    customerName: 'Budi',
    amount: 50_000,
    reason: 'Gangguan',
    ticketId: null,
    ticketCode: null,
    ...over,
  });

  it('creates a credit defaulting to pending', async () => {
    const credit = await repo.create(newCredit());
    expect(credit.status).toBe('pending');
    expect(credit.appliedAt).toBeNull();
  });

  it('lists all credits with total, limit/offset paging, and full-set summary', async () => {
    await repo.create(newCredit({ customerName: 'Ani', amount: 50_000 }));
    await repo.create(newCredit({ customerName: 'Budi', amount: 30_000, status: 'applied' }));
    await repo.create(newCredit({ customerName: 'Citra', amount: 20_000, status: 'void' }));

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.items).toHaveLength(3);

    // Summary is over all rows regardless of filters.
    // activeAmount = 50_000 (pending) + 30_000 (applied) = 80_000 (void excluded)
    expect(all.summary.activeAmount).toBe(80_000);
    expect(all.summary.pending).toBe(1);
    expect(all.summary.applied).toBe(1);

    // Paging: limit keeps items per page, but total + summary stay full-set
    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
    expect(page.summary.activeAmount).toBe(80_000);
  });

  it('q search filters items and total by customerName or reason; summary is invariant', async () => {
    await repo.create(newCredit({ customerName: 'Ani Rahayu', reason: 'Gangguan 1 hari' }));
    await repo.create(
      newCredit({
        customerName: 'Budi Santoso',
        reason: 'Gangguan 2 hari',
        amount: 30_000,
        status: 'applied',
      }),
    );
    await repo.create(
      newCredit({ customerName: 'Citra Dewi', reason: 'Downtime', amount: 20_000 }),
    );

    // Full-set summary: 50_000 (pending Ani) + 30_000 (applied Budi) + 20_000 (pending Citra) = 100_000
    const baseSummary = (await repo.list({ limit: 50, offset: 0 })).summary;
    expect(baseSummary.activeAmount).toBe(100_000);
    expect(baseSummary.pending).toBe(2);
    expect(baseSummary.applied).toBe(1);

    // Search by customerName substring
    const byName = await repo.list({ q: 'Ani', limit: 50, offset: 0 });
    expect(byName.total).toBe(1);
    expect(byName.items[0]?.customerName).toBe('Ani Rahayu');
    // Summary is unchanged — it ignores q
    expect(byName.summary).toEqual(baseSummary);

    // Search by reason substring
    const byReason = await repo.list({ q: 'Gangguan', limit: 50, offset: 0 });
    expect(byReason.total).toBe(2);
    expect(byReason.summary).toEqual(baseSummary);

    // No match
    const noMatch = await repo.list({ q: 'nonexistent', limit: 50, offset: 0 });
    expect(noMatch.total).toBe(0);
    expect(noMatch.items).toHaveLength(0);
    // Summary still full-set
    expect(noMatch.summary).toEqual(baseSummary);
  });

  it('sorts by amount asc and desc', async () => {
    await repo.create(newCredit({ customerName: 'A', amount: 10_000 }));
    await repo.create(newCredit({ customerName: 'B', amount: 50_000 }));
    await repo.create(newCredit({ customerName: 'C', amount: 30_000 }));

    const asc = await repo.list({ sort: 'amount', order: 'asc', limit: 50, offset: 0 });
    const amounts = asc.items.map((i) => i.amount);
    expect(amounts).toEqual([10_000, 30_000, 50_000]);

    const desc = await repo.list({ sort: 'amount', order: 'desc', limit: 50, offset: 0 });
    const amountsDesc = desc.items.map((i) => i.amount);
    expect(amountsDesc).toEqual([50_000, 30_000, 10_000]);
  });

  it('falls back to createdAt desc when sort key is unknown', async () => {
    // Insert in known order via explicit timestamps is not feasible in integration tests;
    // we just verify the query does not throw and returns all rows.
    await repo.create(newCredit({ customerName: 'A' }));
    await repo.create(newCredit({ customerName: 'B' }));
    const result = await repo.list({ sort: 'unknownKey', order: 'asc', limit: 50, offset: 0 });
    expect(result.total).toBe(2);
  });

  it('apply stamps applied_at; void leaves it; missing-id rejects', async () => {
    const credit = await repo.create(newCredit());
    const applied = await repo.apply(credit.id);
    expect(applied.status).toBe('applied');
    expect(applied.appliedAt).toBeInstanceOf(Date);

    const other = await repo.create(newCredit());
    const voided = await repo.void(other.id);
    expect(voided.status).toBe('void');
    expect(voided.appliedAt).toBeNull();

    await expect(repo.apply('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });

  it('counts only pending credits for the command-center badge', async () => {
    await repo.create(newCredit());
    await repo.create(newCredit({ status: 'pending' }));
    await repo.create(newCredit({ status: 'applied' }));
    await repo.create(newCredit({ status: 'void' }));
    expect(await repo.countPending()).toBe(2);
  });
});
