import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { SCHEDULER_JOBS, SCHEDULER_QUEUE } from './scheduler.constants';

/**
 * Producer side of the automation backbone (P2.1). On boot it registers the
 * repeatable job schedulers so the billing→isolir→dunning cascade, the SLA
 * scan, and the intent expire-sweep run on a clock instead of an operator
 * click. `upsertJobScheduler` is idempotent by key, so every API replica
 * registering the same set converges to one schedule — no double-fire.
 *
 * The manual POST /v1/billing/* endpoints stay as operator overrides.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(@InjectQueue(SCHEDULER_QUEUE) private readonly queue: Queue) {}

  onModuleInit(): void {
    // Register in the background so a Redis blip (or a test/CI env with no
    // Redis) never blocks or crashes API boot — the schedulers are stored in
    // Redis, so a later successful boot re-registers them idempotently.
    void this.registerSchedulers();
  }

  private async registerSchedulers(): Promise<void> {
    try {
      for (const job of Object.values(SCHEDULER_JOBS)) {
        await this.queue.upsertJobScheduler(job.key, { pattern: job.pattern }, { name: job.name });
      }
      this.logger.log(
        { jobs: Object.values(SCHEDULER_JOBS).map((j) => j.key) },
        'registered repeatable jobs',
      );
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'failed to register repeatable jobs — will retry on next boot',
      );
    }
  }
}
