import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleService } from '../../infrastructure/database/drizzle.service';
import * as schema from '../../infrastructure/database/schema';
import {
  notificationLog,
  notificationTemplates,
} from '../../infrastructure/database/schema/notifications.schema';
import { NotificationsRepository } from './notifications.repository';

/**
 * Real Postgres integration test for NotificationsRepository. Requires Docker.
 * Schema applied by hand (mirroring migration 0015).
 */
describe('NotificationsRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let repo: NotificationsRepository;

  const DEFAULTS = [
    { event: 'invoice_created' as const, name: 'Tagihan terbit', body: 'Halo {nama}' },
    { event: 'paid' as const, name: 'Pembayaran diterima', body: 'Terima kasih {nama}' },
  ];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await db.execute(`
      CREATE TYPE notification_event AS ENUM ('invoice_created', 'due_soon', 'overdue', 'isolir', 'paid', 'ticket_update');
      CREATE TYPE notification_status AS ENUM ('sent', 'failed');
      CREATE TABLE notification_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event notification_event NOT NULL UNIQUE,
        name varchar(120) NOT NULL,
        channel varchar(20) NOT NULL DEFAULT 'whatsapp',
        body varchar(1000) NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        updated_at timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE TABLE notification_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient varchar(20) NOT NULL,
        template_name varchar(120) NOT NULL,
        channel varchar(20) NOT NULL DEFAULT 'whatsapp',
        status notification_status NOT NULL DEFAULT 'sent',
        body varchar(1000) NOT NULL,
        at timestamptz(3) NOT NULL DEFAULT now()
      );
    `);

    repo = new NotificationsRepository({ db } as unknown as DrizzleService);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(notificationLog);
    await db.delete(notificationTemplates);
  });

  it('ensureSeeded is idempotent on the event unique key', async () => {
    await repo.ensureSeeded(DEFAULTS);
    await repo.ensureSeeded(DEFAULTS);
    const { total } = await repo.listTemplates();
    expect(total).toBe(2);
  });

  it('finds a template by event and updates body/enabled', async () => {
    await repo.ensureSeeded(DEFAULTS);
    const found = await repo.findTemplateByEvent('paid');
    expect(found?.name).toBe('Pembayaran diterima');

    if (!found) throw new Error('seed failed');
    const updated = await repo.updateTemplate(found.id, { enabled: false, body: 'Edited' });
    expect(updated.enabled).toBe(false);
    expect(updated.body).toBe('Edited');

    await expect(
      repo.updateTemplate('00000000-0000-0000-0000-0000000000ff', { enabled: true }),
    ).rejects.toThrow();
  });

  it('appends log entries newest-first with a real total', async () => {
    await repo.addLog({
      recipient: '0811',
      templateName: 'Tagihan terbit',
      body: 'A',
      at: new Date('2026-06-15T01:00:00.000Z'),
    });
    await repo.addLog({
      recipient: '0812',
      templateName: 'Pembayaran diterima',
      body: 'B',
      at: new Date('2026-06-15T02:00:00.000Z'),
    });
    const log = await repo.listLog({ limit: 50, offset: 0 });
    expect(log.total).toBe(2);
    expect(log.items.map((e) => e.recipient)).toEqual(['0812', '0811']);
  });
});
