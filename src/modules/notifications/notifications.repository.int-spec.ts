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
 * Schema applied by hand (mirroring migration 0015, extended by 0047 for the
 * wo_scheduled/wo_done events).
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
      CREATE TYPE notification_event AS ENUM ('invoice_created', 'due_soon', 'overdue', 'isolir', 'paid', 'ticket_update', 'wo_scheduled', 'wo_done');
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

  describe('listLog — search (q)', () => {
    it('matches by recipient substring case-insensitively', async () => {
      await repo.addLog({ recipient: '08110001', templateName: 'Tagihan terbit', body: 'A' });
      await repo.addLog({ recipient: '08220002', templateName: 'Pembayaran diterima', body: 'B' });

      const result = await repo.listLog({ q: '0811', limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.recipient).toBe('08110001');
    });

    it('matches by templateName substring case-insensitively', async () => {
      await repo.addLog({ recipient: '0811', templateName: 'Tagihan terbit', body: 'A' });
      await repo.addLog({ recipient: '0812', templateName: 'Pembayaran diterima', body: 'B' });
      await repo.addLog({ recipient: '0813', templateName: 'Tagihan jatuh tempo', body: 'C' });

      const result = await repo.listLog({ q: 'tagihan', limit: 50, offset: 0 });
      expect(result.total).toBe(2);
    });

    it('total reflects q filter, not the full table count', async () => {
      await repo.addLog({ recipient: 'MATCH-0811', templateName: 'Tagihan terbit', body: 'A' });
      await repo.addLog({ recipient: 'MATCH-0812', templateName: 'Tagihan terbit', body: 'B' });
      await repo.addLog({
        recipient: '0813-other',
        templateName: 'Pembayaran diterima',
        body: 'C',
      });

      const result = await repo.listLog({ q: 'MATCH', limit: 50, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
    });

    it('returns empty result when q matches nothing', async () => {
      await repo.addLog({ recipient: '0811', templateName: 'Tagihan terbit', body: 'A' });

      const result = await repo.listLog({ q: 'doesnotexist', limit: 50, offset: 0 });
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });

  describe('listLog — sort', () => {
    it('sorts by at ascending', async () => {
      await repo.addLog({
        recipient: '0813',
        templateName: 'C-Template',
        body: 'C',
        at: new Date('2026-06-15T03:00:00.000Z'),
      });
      await repo.addLog({
        recipient: '0811',
        templateName: 'A-Template',
        body: 'A',
        at: new Date('2026-06-15T01:00:00.000Z'),
      });
      await repo.addLog({
        recipient: '0812',
        templateName: 'B-Template',
        body: 'B',
        at: new Date('2026-06-15T02:00:00.000Z'),
      });

      const result = await repo.listLog({ sort: 'at', order: 'asc', limit: 50, offset: 0 });
      expect(result.items.map((e) => e.recipient)).toEqual(['0811', '0812', '0813']);
    });

    it('sorts by at descending (default)', async () => {
      await repo.addLog({
        recipient: '0811',
        templateName: 'A-Template',
        body: 'A',
        at: new Date('2026-06-15T01:00:00.000Z'),
      });
      await repo.addLog({
        recipient: '0813',
        templateName: 'C-Template',
        body: 'C',
        at: new Date('2026-06-15T03:00:00.000Z'),
      });

      const result = await repo.listLog({ sort: 'at', order: 'desc', limit: 50, offset: 0 });
      expect(result.items.map((e) => e.recipient)).toEqual(['0813', '0811']);
    });

    it('sorts by to (recipient) ascending', async () => {
      await repo.addLog({ recipient: 'C-recipient', templateName: 'Template', body: 'C' });
      await repo.addLog({ recipient: 'A-recipient', templateName: 'Template', body: 'A' });
      await repo.addLog({ recipient: 'B-recipient', templateName: 'Template', body: 'B' });

      const result = await repo.listLog({ sort: 'to', order: 'asc', limit: 50, offset: 0 });
      expect(result.items.map((e) => e.recipient)).toEqual([
        'A-recipient',
        'B-recipient',
        'C-recipient',
      ]);
    });

    it('sorts by to (recipient) descending', async () => {
      await repo.addLog({ recipient: 'C-recipient', templateName: 'Template', body: 'C' });
      await repo.addLog({ recipient: 'A-recipient', templateName: 'Template', body: 'A' });
      await repo.addLog({ recipient: 'B-recipient', templateName: 'Template', body: 'B' });

      const result = await repo.listLog({ sort: 'to', order: 'desc', limit: 50, offset: 0 });
      expect(result.items.map((e) => e.recipient)).toEqual([
        'C-recipient',
        'B-recipient',
        'A-recipient',
      ]);
    });

    it('falls back to at desc when sort key is unknown', async () => {
      await repo.addLog({
        recipient: '0811',
        templateName: 'Template-1',
        body: 'A',
        at: new Date('2026-06-15T01:00:00.000Z'),
      });
      await repo.addLog({
        recipient: '0812',
        templateName: 'Template-2',
        body: 'B',
        at: new Date('2026-06-15T02:00:00.000Z'),
      });

      const result = await repo.listLog({ sort: 'notAColumn', order: 'asc', limit: 50, offset: 0 });
      // Unknown sort → default at desc → newest first
      expect(result.items[0]?.recipient).toBe('0812');
    });
  });

  describe('listLog — paging', () => {
    it('limit and offset respect q-filtered total', async () => {
      for (let i = 1; i <= 5; i++) {
        await repo.addLog({
          recipient: `SEARCH-${String(i).padStart(4, '0')}`,
          templateName: 'Tagihan terbit',
          body: `Body ${i}`,
        });
      }
      await repo.addLog({
        recipient: '0820-other',
        templateName: 'Pembayaran diterima',
        body: 'X',
      });

      const page1 = await repo.listLog({ q: 'SEARCH', limit: 3, offset: 0 });
      expect(page1.total).toBe(5); // filtered total — not 6
      expect(page1.items).toHaveLength(3);

      const page2 = await repo.listLog({ q: 'SEARCH', limit: 3, offset: 3 });
      expect(page2.total).toBe(5);
      expect(page2.items).toHaveLength(2);
    });
  });
});
