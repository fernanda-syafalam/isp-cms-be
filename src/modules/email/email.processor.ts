import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { EMAIL_QUEUE } from './email.constants';
import { EmailGateway } from './email.gateway';
import type { SendEmailJob } from './email.service';

/**
 * Worker for the `email` queue. Lives in the worker process
 * (entrypoint `dist/worker.js`); HTTP requests do not run this code.
 *
 * Concurrency 10 is a safe default for an email-shaped workload — IO
 * bound, no DB writes per job. Tune downwards if the gateway's rate
 * limit is tighter, or upwards once you measure the real bottleneck.
 */
@Processor(EMAIL_QUEUE, { concurrency: 10 })
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(private readonly gateway: EmailGateway) {
    super();
  }

  async process(job: Job<SendEmailJob>): Promise<{ messageId: string }> {
    const result = await this.gateway.send({
      to: job.data.to,
      templateId: job.data.templateId,
      variables: job.data.variables,
    });
    this.logger.log(
      { jobId: job.id, idempotencyKey: job.data.idempotencyKey, messageId: result.messageId },
      'email sent',
    );
    return result;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SendEmailJob>, err: Error): void {
    this.logger.error(
      {
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        idempotencyKey: job.data.idempotencyKey,
        err: err.message,
      },
      'email job failed',
    );
  }
}
