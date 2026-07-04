import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { vouchers } from '../../infrastructure/database/schema/vouchers.schema';
import { VouchersRepository } from './vouchers.repository';

/**
 * Real Postgres integration test for VouchersRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0009).
 */
describe('VouchersRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: VouchersRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE voucher_status AS ENUM ('unused', 'used', 'expired');
      CREATE TABLE vouchers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(32) NOT NULL UNIQUE,
        batch_id varchar(32) NOT NULL,
        profile varchar(80) NOT NULL,
        price_idr integer NOT NULL,
        duration_days integer NOT NULL,
        status voucher_status NOT NULL DEFAULT 'unused',
        used_at timestamptz(3),
        used_by varchar(120),
        redeemed_customer_id uuid,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    repo = new VouchersRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(vouchers);
  });

  const batchRows = (
    n: number,
    batchId: string,
    over: Partial<typeof vouchers.$inferInsert> = {},
  ) =>
    Array.from({ length: n }, (_, i) => ({
      code: `ASH-${batchId}-${String(i).padStart(2, '0')}`,
      batchId,
      profile: 'Hotspot 1 Hari',
      priceIdr: 5_000,
      durationDays: 1,
      ...over,
    }));

  it('bulk-inserts a batch and rejects duplicate codes', async () => {
    const created = await repo.createBatch(batchRows(3, 'B1'));
    expect(created).toBe(3);
    await expect(repo.createBatch(batchRows(1, 'B1'))).rejects.toThrow(); // code collision
  });

  it('lists by status with a real total and limit/offset', async () => {
    await repo.createBatch(batchRows(2, 'B2'));
    await repo.createBatch(batchRows(1, 'B3', { status: 'used' }));

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);

    const unused = await repo.list({ status: 'unused', limit: 50, offset: 0 });
    expect(unused.total).toBe(2);

    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('redeems a voucher, defaulting usedBy and stamping usedAt', async () => {
    await repo.createBatch(batchRows(1, 'B4'));
    const [item] = (await repo.list({ limit: 1, offset: 0 })).items;
    if (!item) throw new Error('seed failed');

    const redeemed = await repo.redeem(item.id);
    expect(redeemed.status).toBe('used');
    expect(redeemed.usedAt).toBeInstanceOf(Date);
    expect(redeemed.usedBy).toBe('Admin (manual)');

    await expect(repo.redeem('00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });

  it('preserves an existing usedBy on redeem', async () => {
    await repo.createBatch(batchRows(1, 'B5', { usedBy: 'Hotspot user 5' }));
    const [item] = (await repo.list({ limit: 1, offset: 0 })).items;
    if (!item) throw new Error('seed failed');
    const redeemed = await repo.redeem(item.id);
    expect(redeemed.usedBy).toBe('Hotspot user 5');
  });
});
