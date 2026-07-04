import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { BillingAutomationService } from '../invoices/billing-automation.service';
import { InvoicesService } from '../invoices/invoices.service';
import { PaymentIntentsService } from '../invoices/payment-intents.service';
import { TicketsService } from '../tickets/tickets.service';
import { SCHEDULER_JOBS, SCHEDULER_QUEUE, type SchedulerJobName } from './scheduler.constants';

/**
 * Consumer for the cron-fired scheduler jobs (P2.1). Each job name maps to one
 * domain-service call — the processor holds no business logic, only the
 * dispatch table. Retries/backoff come from the root QueueModule defaults, so
 * a transient DB blip re-runs the tick instead of skipping a billing cycle.
 *
 * Concurrency 1: these are coarse maintenance sweeps, not per-item work, and
 * serialising them keeps a slow billing run from overlapping its next tick.
 */
@Processor(SCHEDULER_QUEUE, { concurrency: 1 })
export class SchedulerProcessor extends WorkerHost {
  private readonly logger = new Logger(SchedulerProcessor.name);

  constructor(
    private readonly invoices: InvoicesService,
    private readonly billing: BillingAutomationService,
    private readonly tickets: TicketsService,
    private readonly paymentIntents: PaymentIntentsService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const name = job.name as SchedulerJobName;
    switch (name) {
      case SCHEDULER_JOBS.billingRun.name:
        await this.invoices.run();
        return;
      case SCHEDULER_JOBS.billingIsolirOverdue.name:
        await this.billing.isolirOverdue();
        return;
      case SCHEDULER_JOBS.billingDunning.name:
        await this.billing.remind({});
        return;
      case SCHEDULER_JOBS.ticketsSlaScan.name:
        await this.tickets.scanSla();
        return;
      case SCHEDULER_JOBS.paymentIntentsExpireSweep.name:
        await this.paymentIntents.expireStale();
        return;
      default:
        // Exhaustiveness guard: a new SCHEDULER_JOBS entry without a case here
        // fails the type-check, not silently at runtime.
        this.assertNever(name, job.name);
    }
  }

  private assertNever(_value: never, jobName: string): void {
    this.logger.warn({ jobName }, 'scheduler received an unknown job name');
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): void {
    this.logger.error(
      { jobId: job.id, name: job.name, attemptsMade: job.attemptsMade, err: err.message },
      'scheduler job failed',
    );
  }
}
