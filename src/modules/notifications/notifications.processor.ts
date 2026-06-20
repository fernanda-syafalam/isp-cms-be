import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { SendNotificationInput } from './dto/send-notification.dto';
import { NOTIFICATIONS_QUEUE } from './notifications.constants';
import { NotificationsService } from './notifications.service';

/**
 * Worker for the `notifications` queue (WhatsApp dunning + lifecycle events).
 * Lives in the worker process (`dist/worker.js`); HTTP/scheduler code enqueues,
 * the worker delivers via NotificationsService.send.
 *
 * Concurrency 10 mirrors the email worker — IO-bound, one log write per job.
 * Retries/backoff come from the root QueueModule defaults (3 attempts,
 * exponential), so a transient WhatsApp-gateway failure is retried instead of
 * dropped — the gap ADR-0012 closes.
 */
@Processor(NOTIFICATIONS_QUEUE, { concurrency: 10 })
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(private readonly notifications: NotificationsService) {
    super();
  }

  async process(job: Job<SendNotificationInput>): Promise<void> {
    await this.notifications.send(job.data);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SendNotificationInput>, err: Error): void {
    this.logger.error(
      { jobId: job.id, attemptsMade: job.attemptsMade, event: job.data.event, err: err.message },
      'notification job failed',
    );
  }
}
