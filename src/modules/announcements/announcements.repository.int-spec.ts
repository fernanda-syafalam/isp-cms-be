import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import {
  type NewAnnouncement,
  announcements,
} from '../../infrastructure/database/schema/announcements.schema';
import { buildAnnouncementFixture } from './announcements.fixtures';
import { AnnouncementsRepository } from './announcements.repository';

/**
 * Real Postgres integration test for AnnouncementsRepository. Requires
 * Docker. Schema applied by hand (mirroring migration 0040) — CREATE TABLE
 * announcements only, no other tables (self-contained island).
 */
describe('AnnouncementsRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: AnnouncementsRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE announcement_severity AS ENUM ('info', 'warning', 'outage');
      CREATE TABLE announcements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title varchar(160) NOT NULL,
        body varchar(1000) NOT NULL,
        severity announcement_severity NOT NULL DEFAULT 'info',
        active boolean NOT NULL DEFAULT true,
        starts_at timestamptz(3),
        ends_at timestamptz(3),
        created_at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    repo = new AnnouncementsRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(announcements);
  });

  it('seeds the fixture on first read, idempotent on the deterministic id', async () => {
    await repo.ensureSeeded(buildAnnouncementFixture());
    await repo.ensureSeeded(buildAnnouncementFixture());
    const rows = await repo.list();
    expect(rows).toHaveLength(2);
  });

  describe('listActive windowing', () => {
    const base: NewAnnouncement = {
      title: 'Judul',
      body: 'Isi pengumuman',
      severity: 'info',
      active: true,
      startsAt: null,
      endsAt: null,
    };

    it('excludes a row where active is false', async () => {
      await repo.create({ ...base, active: false });
      expect(await repo.listActive()).toHaveLength(0);
      expect(await repo.list()).toHaveLength(1);
    });

    it('includes an open-ended row (no startsAt/endsAt)', async () => {
      await repo.create(base);
      expect(await repo.listActive()).toHaveLength(1);
    });

    it('excludes a row whose startsAt is in the future', async () => {
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await repo.create({ ...base, startsAt: future });
      expect(await repo.listActive()).toHaveLength(0);
    });

    it('includes a row whose startsAt is in the past', async () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await repo.create({ ...base, startsAt: past });
      expect(await repo.listActive()).toHaveLength(1);
    });

    it('excludes a row whose endsAt is in the past', async () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await repo.create({ ...base, endsAt: past });
      expect(await repo.listActive()).toHaveLength(0);
    });

    it('includes a row whose endsAt is in the future', async () => {
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await repo.create({ ...base, endsAt: future });
      expect(await repo.listActive()).toHaveLength(1);
    });

    it('orders newest first (createdAt desc)', async () => {
      const first = await repo.create({ ...base, title: 'First' });
      // Back-date the first row so ordering does not depend on real clock
      // granularity between the two inserts.
      await db
        .update(announcements)
        .set({ createdAt: new Date(Date.now() - 10_000) })
        .where(eq(announcements.id, first.id));
      const second = await repo.create({ ...base, title: 'Second' });
      const rows = await repo.listActive();
      expect(rows[0]?.id).toBe(second.id);
      expect(rows[1]?.id).toBe(first.id);
    });
  });
});
