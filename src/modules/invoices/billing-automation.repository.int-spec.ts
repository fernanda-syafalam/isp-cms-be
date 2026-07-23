import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { invoices } from '../../infrastructure/database/schema/invoices.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { applyMigrations } from '../../test-utils/apply-migrations';
import { InvoicesRepository } from './invoices.repository';

// `YYYY-MM-DD` for `n` days before today, in UTC — same basis the
// container's Postgres `current_date` uses (TODO(TIME-1) tracks the
// separate, known UTC-vs-local skew; not addressed here).
function sqlDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Real Postgres integration test for the billing-automation repo methods
 * (date-based overdue logic). Requires Docker. Schema comes from the REAL
 * `drizzle/*.sql` migrations (TEST-H1) — the single source of truth —
 * instead of a hand-mirrored `CREATE TABLE` DDL.
 */
describe('InvoicesRepository billing-automation (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: InvoicesRepository;
  let customerId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await applyMigrations(pool);

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
        status: 'aktif',
      })
      .returning();
    if (!customer) throw new Error('customer seed failed');
    customerId = customer.id;

    repo = new InvoicesRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(invoices);
  });

  it('markOverduePastDue flips only past-due pending invoices + applies fee', async () => {
    await db.insert(invoices).values([
      {
        customerId,
        customerName: 'Budi',
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        amount: 200_000,
        dueDate: '2020-01-10',
        status: 'pending',
      },
      {
        customerId,
        customerName: 'Budi',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        amount: 200_000,
        dueDate: '2999-01-10',
        status: 'pending',
      },
    ]);

    const flipped = await repo.markOverduePastDue(25_000);
    expect(flipped).toBe(1);
    expect(await repo.countOverdueAll()).toBe(1);

    const ids = await repo.customerIdsWithOverdue();
    expect(ids).toEqual([customerId]);

    // the overdue one now carries the late fee + total includes it
    expect(await repo.sumUnpaidByCustomer(customerId)).toBe(200_000 + 25_000 + 200_000);
  });

  // D2: isolir eligibility must respect the configured grace period —
  // dueDate + graceDays < today, evaluated against the real Postgres
  // `current_date` (not JS date math).
  it('customerIdsIsolirEligible only returns customers past grace, not customers still within it', async () => {
    const graceDays = 3;
    await db.insert(invoices).values([
      {
        // Due 2 days ago: within the 3-day grace window -> NOT eligible.
        customerId,
        customerName: 'Budi',
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        amount: 200_000,
        dueDate: sqlDaysAgo(2),
        status: 'overdue',
      },
    ]);
    expect(await repo.customerIdsIsolirEligible(graceDays)).toEqual([]);

    await db.delete(invoices);
    await db.insert(invoices).values([
      {
        // Due 5 days ago: beyond the 3-day grace window -> eligible.
        customerId,
        customerName: 'Budi',
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        amount: 200_000,
        dueDate: sqlDaysAgo(5),
        status: 'overdue',
      },
    ]);
    expect(await repo.customerIdsIsolirEligible(graceDays)).toEqual([customerId]);
  });

  it('markRemindedOverdue stamps last_reminded_at on overdue invoices', async () => {
    await db.insert(invoices).values({
      customerId,
      customerName: 'Budi',
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      amount: 200_000,
      dueDate: '2020-01-10',
      status: 'overdue',
    });
    const reminded = await repo.markRemindedOverdue();
    expect(reminded).toBe(1);
    const { items } = await repo.list({ status: 'overdue', limit: 10, offset: 0 });
    expect(items[0]?.lastRemindedAt).toBeInstanceOf(Date);
  });
});
