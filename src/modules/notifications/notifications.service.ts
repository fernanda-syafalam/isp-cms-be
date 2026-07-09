import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type {
  NewNotificationTemplate,
  NotificationLogEntry,
  NotificationTemplate,
} from '../../infrastructure/database/schema/notifications.schema';
import type {
  NotificationLogResponse,
  NotificationTemplateResponse,
} from './dto/notification-response.dto';
import type { SendNotificationInput } from './dto/send-notification.dto';
import type { UpdateTemplateInput } from './dto/update-template.dto';
import { NOTIFICATIONS_QUEUE } from './notifications.constants';
import { type LogListFilter, NotificationsRepository } from './notifications.repository';
import { NotificationTransport } from './transports/notification-transport';

// Default templates, seeded on first read. Admins edit body/enabled after.
const DEFAULT_TEMPLATES: NewNotificationTemplate[] = [
  {
    event: 'invoice_created',
    name: 'Tagihan terbit',
    body: 'Halo {nama}, tagihan {no_tagihan} sebesar {jumlah} telah terbit. Jatuh tempo {jatuh_tempo}.',
  },
  {
    event: 'due_soon',
    name: 'Pengingat H-3',
    body: 'Halo {nama}, tagihan {no_tagihan} ({jumlah}) jatuh tempo {jatuh_tempo}. Mohon segera melakukan pembayaran.',
  },
  {
    event: 'overdue',
    name: 'Tagihan jatuh tempo',
    body: 'Halo {nama}, tagihan {no_tagihan} sebesar {jumlah} telah melewati jatuh tempo. Mohon segera dibayar.',
  },
  {
    event: 'isolir',
    name: 'Pemberitahuan isolir',
    body: 'Halo {nama}, layanan Anda diisolir karena tagihan {no_tagihan} belum dibayar. Hubungi kami untuk reaktivasi.',
  },
  {
    event: 'paid',
    name: 'Pembayaran diterima',
    body: 'Terima kasih {nama}, pembayaran tagihan {no_tagihan} sebesar {jumlah} telah kami terima.',
  },
  {
    event: 'ticket_update',
    name: 'Update tiket',
    body: 'Halo {nama}, ada pembaruan pada tiket dukungan Anda. Tim kami akan menindaklanjuti.',
  },
  {
    event: 'wo_scheduled',
    name: 'Jadwal kunjungan teknisi',
    body: 'Halo {nama}, {tipe} Anda (kode {kode}) dijadwalkan pada {jadwal}. Teknisi kami akan datang sesuai jadwal.',
  },
  {
    event: 'wo_done',
    name: 'Pekerjaan selesai',
    body: 'Halo {nama}, {tipe} Anda (kode {kode}) telah selesai dikerjakan pada {selesai}. Terima kasih telah menggunakan layanan kami.',
  },
];

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly repo: NotificationsRepository,
    // Producer side of the dunning queue. Enqueued sends are retried by the
    // worker (NotificationsProcessor); the synchronous send() below is the
    // delivery the worker performs.
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue<SendNotificationInput>,
    // The SEND seam (ADR-0017): LogTransport (default) or WhatsAppTransport,
    // selected by NOTIFICATION_MODE in notifications.module.ts. send() below
    // always writes the notification_log row regardless of which transport
    // is wired in — the transport is the send, the log row is the record.
    private readonly transport: NotificationTransport,
  ) {}

  async listTemplates(): Promise<{ items: NotificationTemplateResponse[]; total: number }> {
    await this.repo.ensureSeeded(DEFAULT_TEMPLATES);
    const { items, total } = await this.repo.listTemplates();
    return { items: items.map(toTemplateResponse), total };
  }

  async updateTemplate(
    id: string,
    input: UpdateTemplateInput,
  ): Promise<NotificationTemplateResponse> {
    const template = await this.repo.updateTemplate(id, input);
    this.logger.log({ templateId: id }, 'notification template updated');
    return toTemplateResponse(template);
  }

  async listLog(
    filter: LogListFilter,
  ): Promise<{ items: NotificationLogResponse[]; total: number }> {
    const { items, total } = await this.repo.listLog(filter);
    return { items: items.map(toLogResponse), total };
  }

  /**
   * Render the event's template, hand it to the delivery transport
   * (ADR-0017), and append a send-log entry recording the outcome. The log
   * row is written regardless of transport result — it is the permanent
   * delivery record; the transport result only decides `sent` vs `failed`
   * and whether this call rethrows to trigger a BullMQ retry.
   */
  async send(input: SendNotificationInput): Promise<void> {
    await this.repo.ensureSeeded(DEFAULT_TEMPLATES);
    const template = await this.repo.findTemplateByEvent(input.event);
    if (!template) throw new NotFoundException('template not found');

    const message = renderTemplate(template.body, input.vars ?? {});
    const result = await this.transport.send({ to: input.to, event: input.event, message });

    await this.repo.addLog({
      recipient: input.to,
      templateName: template.name,
      body: message,
      status: result.delivered ? 'sent' : 'failed',
    });

    if (!result.delivered) {
      this.logger.warn(
        { event: input.event, to: input.to },
        'notification transport delivery failed',
      );
      // Rethrow so the caller (NotificationsProcessor.process, in the queue
      // path) fails the job and BullMQ retries per its existing
      // attempts/backoff config — the log row above already recorded this
      // attempt as 'failed', so the retry is never lost from the audit
      // trail even if every attempt ultimately fails.
      throw new Error(`notification delivery failed for event "${input.event}"`);
    }

    this.logger.log({ event: input.event, to: input.to }, 'notification sent');
  }

  /**
   * Producer: enqueue a notification for asynchronous, retried delivery
   * (ADR-0012). `jobId` makes the enqueue idempotent so re-running a dunning
   * cycle never double-sends; the worker calls send() to deliver.
   */
  async enqueue(input: SendNotificationInput, jobId: string): Promise<void> {
    await this.queue.add('send', input, { jobId });
  }
}

// Substitute {placeholder} tokens with the send payload's vars. A missing
// key is left literal — an honest gap beats a fabricated sample value (P2.2).
function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

function toTemplateResponse(row: NotificationTemplate): NotificationTemplateResponse {
  return {
    id: row.id,
    event: row.event,
    name: row.name,
    channel: 'whatsapp',
    body: row.body,
    enabled: row.enabled,
  };
}

function toLogResponse(row: NotificationLogEntry): NotificationLogResponse {
  return {
    id: row.id,
    to: row.recipient,
    templateName: row.templateName,
    channel: 'whatsapp',
    status: row.status,
    body: row.body,
    at: row.at.toISOString(),
  };
}
