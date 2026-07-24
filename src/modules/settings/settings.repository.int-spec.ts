import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { appSettings } from '../../infrastructure/database/schema/settings.schema';
import { SettingsRepository } from './settings.repository';

/**
 * Real Postgres integration test for SettingsRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0014, `tax_ppn_rate` type
 * updated per migration 0054 — DB-4: `real` -> `numeric(6, 5)`).
 */
describe('SettingsRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: SettingsRepository;

  const DEFAULTS = {
    companyName: 'Jepara Net',
    companyAddress: 'Jl. Pemuda No. 12',
    companyPhone: '0291-591234',
    companyEmail: 'billing@jeparanet.id',
    billingLateFeeIdr: 25_000,
    billingDueDays: 10,
    billingIsolirGraceDays: 3,
    taxPkp: true,
    taxNpwp: '01.234.567.8-901.000',
    taxPpnRate: 0.11,
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TABLE app_settings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        singleton boolean NOT NULL DEFAULT true UNIQUE,
        company_name varchar(120) NOT NULL,
        company_address varchar(255) NOT NULL,
        company_phone varchar(40) NOT NULL,
        company_email varchar(120) NOT NULL,
        billing_late_fee_idr integer NOT NULL,
        billing_due_days integer NOT NULL,
        billing_isolir_grace_days integer NOT NULL,
        tax_pkp boolean NOT NULL,
        tax_npwp varchar(40) NOT NULL,
        tax_ppn_rate numeric(6, 5) NOT NULL,
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    repo = new SettingsRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(appSettings);
  });

  it('getOrCreate seeds once and stays a singleton on repeated calls', async () => {
    const a = await repo.getOrCreate(DEFAULTS);
    const b = await repo.getOrCreate(DEFAULTS);
    expect(a.id).toBe(b.id);
    const all = await db.select().from(appSettings);
    expect(all).toHaveLength(1);
  });

  it('update patches the single row and bumps updated_at', async () => {
    const seeded = await repo.getOrCreate(DEFAULTS);
    const updated = await repo.update({ billingLateFeeIdr: 50_000, taxPpnRate: 0.12 });
    expect(updated.id).toBe(seeded.id);
    expect(updated.billingLateFeeIdr).toBe(50_000);
    expect(updated.taxPpnRate).toBeCloseTo(0.12);
    expect(await db.select().from(appSettings)).toHaveLength(1);
  });

  // DB-4: `tax_ppn_rate` is now `numeric(6, 5)` (was `real`/float4). 0.055
  // has no exact float4 representation (it round-trips to something like
  // 0.054999999... via single precision) but is exact in base-10 numeric.
  // Also asserts the drizzle `mode: 'number'` mapping returns a JS
  // `number` (not a string) end to end through the repository.
  it('a rate inexact in float4 (0.055) round-trips exactly as a number', async () => {
    await repo.getOrCreate(DEFAULTS);
    const updated = await repo.update({ taxPpnRate: 0.055 });
    expect(updated.taxPpnRate).toBe(0.055);
    expect(typeof updated.taxPpnRate).toBe('number');

    const [row] = await db.select().from(appSettings).limit(1);
    expect(row?.taxPpnRate).toBe(0.055);
    expect(typeof row?.taxPpnRate).toBe('number');
  });

  it('the default PPN rate (0.11) round-trips exactly', async () => {
    const seeded = await repo.getOrCreate(DEFAULTS);
    expect(seeded.taxPpnRate).toBe(0.11);
  });
});
