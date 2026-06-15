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

  it('lists by status with a real total and limit/offset', async () => {
    await repo.create(newCredit());
    await repo.create(newCredit({ status: 'applied' }));
    await repo.create(newCredit({ status: 'applied' }));

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);

    const applied = await repo.list({ status: 'applied', limit: 50, offset: 0 });
    expect(applied.total).toBe(2);

    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
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
