import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import { type LogListFilter, NotificationsRepository } from './notifications.repository';

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
];

// Sample substitution values until the send payload carries real customer/
// invoice context (the FE mock uses the same hardcoded values).
const SAMPLE_VARS: Record<string, string> = {
  nama: 'Budi Santoso',
  no_tagihan: 'INV-2026-100',
  jumlah: 'Rp250.000',
  jatuh_tempo: '10 Mei 2026',
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly repo: NotificationsRepository) {}

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

  /** Render the event's template and append a send-log entry. */
  async send(input: SendNotificationInput): Promise<void> {
    await this.repo.ensureSeeded(DEFAULT_TEMPLATES);
    const template = await this.repo.findTemplateByEvent(input.event);
    if (!template) throw new NotFoundException('template not found');

    await this.repo.addLog({
      recipient: input.to,
      templateName: template.name,
      body: renderTemplate(template.body),
      status: 'sent',
    });
    this.logger.log({ event: input.event, to: input.to }, 'notification sent');
  }
}

function renderTemplate(body: string): string {
  return body.replace(/\{(\w+)\}/g, (match, key: string) => SAMPLE_VARS[key] ?? match);
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
