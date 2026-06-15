import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import { type NewAuditLogEntry, auditLog } from '../../infrastructure/database/schema/audit.schema';
import { AuditRepository } from './audit.repository';

/**
 * Real Postgres integration test for AuditRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0024).
 */
describe('AuditRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: AuditRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TABLE audit_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        at timestamptz(3) NOT NULL DEFAULT now(),
        actor varchar(200) NOT NULL,
        action varchar(120) NOT NULL,
        entity varchar(120) NOT NULL,
        summary varchar(500) NOT NULL,
        entity_id varchar(120)
      );
      CREATE INDEX audit_log_entity_id_idx ON audit_log (entity_id);
      CREATE INDEX audit_log_at_idx ON audit_log (at);
    `);

    repo = new AuditRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(auditLog);
  });

  const entries: NewAuditLogEntry[] = [
    {
      id: '00000000-0000-0000-0000-0000000000e1',
      at: new Date('2026-06-15T01:00:00.000Z'),
      actor: 'admin@ashnet.id',
      action: 'billing.run',
      entity: 'Tagihan',
      summary: 'Penagihan massal',
    },
    {
      id: '00000000-0000-0000-0000-0000000000e2',
      at: new Date('2026-06-15T02:00:00.000Z'),
      actor: 'staff@ashnet.id',
      action: 'customer.suspend',
      entity: 'Pelanggan',
      summary: 'Isolir pelanggan',
      entityId: 'cust-1',
    },
    {
      id: '00000000-0000-0000-0000-0000000000e3',
      at: new Date('2026-06-15T03:00:00.000Z'),
      actor: 'admin@ashnet.id',
      action: 'customer.activate',
      entity: 'Pelanggan',
      summary: 'Aktifkan pelanggan',
      entityId: 'cust-1',
    },
  ];

  it('seeds idempotently on the primary key', async () => {
    await repo.ensureSeeded(entries);
    await repo.ensureSeeded(entries);
    const { total } = await repo.list({ limit: 50, offset: 0 });
    expect(total).toBe(3);
  });

  it('lists newest-first with a real total', async () => {
    await repo.ensureSeeded(entries);
    const { items, total } = await repo.list({ limit: 50, offset: 0 });
    expect(total).toBe(3);
    expect(items[0]?.action).toBe('customer.activate'); // 03:00 is newest
    expect(items[2]?.action).toBe('billing.run'); // 01:00 is oldest
  });

  it('filters by entityId for per-record history', async () => {
    await repo.ensureSeeded(entries);
    const { items, total } = await repo.list({ entityId: 'cust-1', limit: 50, offset: 0 });
    expect(total).toBe(2);
    expect(items.every((e) => e.entityId === 'cust-1')).toBe(true);
  });

  it('paginates with limit/offset', async () => {
    await repo.ensureSeeded(entries);
    const page = await repo.list({ limit: 1, offset: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
    expect(page.items[0]?.action).toBe('customer.suspend'); // 02:00 is the middle row
  });
});
