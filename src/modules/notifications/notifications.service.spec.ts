import { getQueueToken } from '@nestjs/bullmq';
import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationTemplate } from '../../infrastructure/database/schema/notifications.schema';
import { NOTIFICATIONS_QUEUE } from './notifications.constants';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

const template: NotificationTemplate = {
  id: '00000000-0000-0000-0000-00000000b201',
  event: 'invoice_created',
  name: 'Tagihan terbit',
  channel: 'whatsapp',
  body: 'Halo {nama}, tagihan {no_tagihan} sebesar {jumlah} jatuh tempo {jatuh_tempo}.',
  enabled: true,
  updatedAt: new Date('2026-06-15T00:00:00.000Z'),
};

describe('NotificationsService', () => {
  let service: NotificationsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let queue: { add: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      ensureSeeded: vi.fn(),
      listTemplates: vi.fn(),
      findTemplateByEvent: vi.fn(),
      updateTemplate: vi.fn(),
      listLog: vi.fn(),
      addLog: vi.fn(),
    };
    queue = { add: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: NotificationsRepository, useValue: repo },
        { provide: getQueueToken(NOTIFICATIONS_QUEUE), useValue: queue },
      ],
    }).compile();
    service = moduleRef.get(NotificationsService);
  });

  it('listTemplates seeds defaults then maps with channel literal', async () => {
    repo.listTemplates.mockResolvedValue({ items: [template], total: 1 });
    const result = await service.listTemplates();
    expect(repo.ensureSeeded).toHaveBeenCalledTimes(1);
    expect(result.items[0]?.channel).toBe('whatsapp');
    expect(result.items[0]?.event).toBe('invoice_created');
  });

  it('updateTemplate passes the patch through', async () => {
    repo.updateTemplate.mockResolvedValue({ ...template, enabled: false });
    const result = await service.updateTemplate(template.id, { enabled: false });
    expect(repo.updateTemplate).toHaveBeenCalledWith(template.id, { enabled: false });
    expect(result.enabled).toBe(false);
  });

  describe('send', () => {
    it('renders the template with the send payload vars and appends a sent log entry', async () => {
      repo.findTemplateByEvent.mockResolvedValue(template);
      await service.send({
        event: 'invoice_created',
        to: '081200000000',
        vars: {
          nama: 'Siti Rahma',
          no_tagihan: 'INV-2026-207',
          jumlah: 'Rp180.000',
          jatuh_tempo: '20 Jun 2026',
        },
      });
      expect(repo.addLog).toHaveBeenCalledWith(
        expect.objectContaining({
          recipient: '081200000000',
          templateName: 'Tagihan terbit',
          status: 'sent',
          body: 'Halo Siti Rahma, tagihan INV-2026-207 sebesar Rp180.000 jatuh tempo 20 Jun 2026.',
        }),
      );
    });

    it('leaves a placeholder literal when its var is missing (no fabricated value)', async () => {
      repo.findTemplateByEvent.mockResolvedValue(template);
      await service.send({ event: 'invoice_created', to: '081200000000', vars: { nama: 'Ana' } });
      expect(repo.addLog).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'Halo Ana, tagihan {no_tagihan} sebesar {jumlah} jatuh tempo {jatuh_tempo}.',
        }),
      );
    });

    it('throws 404 when no template matches the event', async () => {
      repo.findTemplateByEvent.mockResolvedValue(null);
      await expect(service.send({ event: 'paid', to: '081200000000' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.addLog).not.toHaveBeenCalled();
    });
  });

  describe('enqueue', () => {
    // ADR-0012: producer side — add a job keyed by the idempotency id so a
    // re-run of the dunning cycle cannot double-send.
    it('adds a send job to the queue with the idempotency jobId', async () => {
      await service.enqueue({ event: 'overdue', to: '0812' }, 'dun:overdue:c1:2026-06-01');
      expect(queue.add).toHaveBeenCalledWith(
        'send',
        { event: 'overdue', to: '0812' },
        { jobId: 'dun:overdue:c1:2026-06-01' },
      );
    });
  });

  it('listLog maps entries with to + ISO timestamp', async () => {
    repo.listLog.mockResolvedValue({
      items: [
        {
          id: '00000000-0000-0000-0000-0000000c0001',
          recipient: '0812',
          templateName: 'Tagihan terbit',
          channel: 'whatsapp',
          status: 'sent',
          body: 'Halo Budi',
          at: new Date('2026-06-15T10:00:00.000Z'),
        },
      ],
      total: 1,
    });
    const result = await service.listLog({ limit: 50, offset: 0 });
    expect(result.items[0]?.to).toBe('0812');
    expect(result.items[0]?.at).toBe('2026-06-15T10:00:00.000Z');
  });

  it('listLog forwards q, sort, and order to the repository unchanged', async () => {
    repo.listLog.mockResolvedValue({ items: [], total: 0 });
    await service.listLog({ q: '0812', sort: 'to', order: 'asc', limit: 10, offset: 0 });
    expect(repo.listLog).toHaveBeenCalledWith({
      q: '0812',
      sort: 'to',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
  });

  it('listLog without q passes undefined q to repository', async () => {
    repo.listLog.mockResolvedValue({ items: [], total: 0 });
    await service.listLog({ limit: 20, offset: 5 });
    expect(repo.listLog).toHaveBeenCalledWith({ limit: 20, offset: 5 });
  });
});
