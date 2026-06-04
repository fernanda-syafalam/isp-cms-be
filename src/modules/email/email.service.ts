import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { EMAIL_QUEUE } from './email.constants';

/**
 * Producer side of the email queue. HTTP handlers call this; the
 * actual delivery happens in EmailProcessor in the worker process.
 *
 * Idempotency: every job carries an `idempotencyKey` derived from the
 * business action (e.g. `order-confirm:<orderId>`). BullMQ uses the
 * `jobId` to reject duplicates at insert time. A second-line check
 * (a `sent_emails` table) is recommended in production but kept out of
 * this service to focus on the queue pattern itself — see Pilar 7.
 */
export interface SendEmailJob {
  to: string;
  templateId: string;
  variables: Record<string, string>;
  idempotencyKey: string;
}

@Injectable()
export class EmailService {
  constructor(@InjectQueue(EMAIL_QUEUE) private readonly queue: Queue<SendEmailJob>) {}

  /**
   * Convenience helper for the canonical "order placed -> send confirm"
   * path. Real services tend to grow one helper per template so the
   * `templateId` and `variables` shape are tied together at the type
   * level instead of being open-ended.
   */
  async sendOrderConfirmation(
    orderId: string,
    to: string,
    variables: Record<string, string>,
  ): Promise<void> {
    const idempotencyKey = `order-confirm:${orderId}`;
    await this.queue.add(
      'order-confirm',
      { to, templateId: 'order-confirm', variables, idempotencyKey },
      // jobId == idempotencyKey: BullMQ refuses to enqueue a duplicate.
      { jobId: idempotencyKey },
    );
  }
}
