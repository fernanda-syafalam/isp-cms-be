import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { leads } from '../../infrastructure/database/schema/leads.schema';
import { LeadsRepository } from './leads.repository';

/**
 * Real Postgres integration test for LeadsRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0007).
 */
describe('LeadsRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: LeadsRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE lead_stage AS ENUM ('new', 'survey', 'quote', 'won', 'lost');
      CREATE TYPE lead_source AS ENUM ('walk_in', 'referral', 'online', 'reseller');
      CREATE TABLE leads (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(120) NOT NULL,
        phone varchar(20) NOT NULL,
        address varchar(255) NOT NULL,
        area_name varchar(120) NOT NULL,
        plan_name varchar(80) NOT NULL,
        stage lead_stage NOT NULL DEFAULT 'new',
        est_value integer NOT NULL,
        source lead_source NOT NULL,
        note varchar(500),
        reseller_id uuid,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    repo = new LeadsRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(leads);
  });

  const newLead = (over: Partial<typeof leads.$inferInsert> = {}) => ({
    name: 'Citra',
    phone: '0812',
    address: 'Jl. A',
    areaName: 'Jepara',
    planName: 'Home 20',
    estValue: 200_000,
    source: 'online' as const,
    note: null,
    ...over,
  });

  it('creates a lead defaulting to stage new', async () => {
    const lead = await repo.create(newLead());
    expect(lead.stage).toBe('new');
    expect(lead.note).toBeNull();
  });

  it('round-trips a lead created with a resellerId (P3.D.2)', async () => {
    const resellerId = '00000000-0000-0000-0000-0000000000a1';
    const lead = await repo.create(newLead({ resellerId }));
    expect(lead.resellerId).toBe(resellerId);

    const found = await repo.findById(lead.id);
    expect(found?.resellerId).toBe(resellerId);
  });

  it('defaults resellerId to null when omitted', async () => {
    const lead = await repo.create(newLead());
    expect(lead.resellerId).toBeNull();
  });

  it('lists by stage with a real total and limit/offset', async () => {
    await repo.create(newLead());
    await repo.create(newLead({ stage: 'won' }));
    await repo.create(newLead({ stage: 'won' }));

    const all = await repo.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);

    const won = await repo.list({ stage: 'won', limit: 50, offset: 0 });
    expect(won.total).toBe(2);

    const page = await repo.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('sets the stage and rejects a missing lead', async () => {
    const created = await repo.create(newLead());
    const moved = await repo.setStage(created.id, 'quote');
    expect(moved.stage).toBe('quote');
    await expect(repo.setStage('00000000-0000-0000-0000-0000000000ff', 'won')).rejects.toThrow();
  });

  it('sums value and counts only the active pipeline (new/survey/quote)', async () => {
    await repo.create(newLead({ stage: 'new', estValue: 100_000 }));
    await repo.create(newLead({ stage: 'survey', estValue: 200_000 }));
    await repo.create(newLead({ stage: 'quote', estValue: 300_000 }));
    // Terminal stages are excluded.
    await repo.create(newLead({ stage: 'won', estValue: 999_000 }));
    await repo.create(newLead({ stage: 'lost', estValue: 999_000 }));

    expect(await repo.activePipeline()).toEqual({ value: 600_000, count: 3 });
  });

  it('reports an empty pipeline as zero value and count', async () => {
    expect(await repo.activePipeline()).toEqual({ value: 0, count: 0 });
  });
});
