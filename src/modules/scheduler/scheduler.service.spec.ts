import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULER_JOBS, SCHEDULER_TZ } from './scheduler.constants';
import { SchedulerService } from './scheduler.service';

/**
 * TIME-1 regression guard: every repeatable job must be registered with
 * `tz: SCHEDULER_TZ` (Asia/Jakarta), not left to the ambient container
 * clock — see scheduler.constants.ts's SCHEDULER_TZ doc comment for why.
 */
describe('SchedulerService', () => {
  let queue: { upsertJobScheduler: ReturnType<typeof vi.fn> };
  let service: SchedulerService;

  beforeEach(() => {
    queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) };
    service = new SchedulerService(queue as unknown as Queue);
  });

  it('registers every SCHEDULER_JOBS entry with its cron pattern pinned to SCHEDULER_TZ', async () => {
    // registerSchedulers is private; onModuleInit fires it in the
    // background ("void this.registerSchedulers()") so a Redis blip never
    // blocks boot — await the private method directly for a deterministic
    // assertion instead of racing the fire-and-forget call.
    await (service as unknown as { registerSchedulers(): Promise<void> }).registerSchedulers();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(Object.keys(SCHEDULER_JOBS).length);
    for (const job of Object.values(SCHEDULER_JOBS)) {
      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
        job.key,
        { pattern: job.pattern, tz: SCHEDULER_TZ },
        { name: job.name },
      );
    }
  });

  it('SCHEDULER_TZ is Asia/Jakarta (WIB) — the ADR-0018 #5 quiet-isolir window is WIB, not UTC', () => {
    expect(SCHEDULER_TZ).toBe('Asia/Jakarta');
  });

  it('onModuleInit swallows a registration failure (e.g. Redis unavailable) instead of crashing boot', async () => {
    queue.upsertJobScheduler.mockRejectedValueOnce(new Error('redis down'));

    expect(() => service.onModuleInit()).not.toThrow();
    // Flush the fire-and-forget promise so an uncaught rejection (if the
    // try/catch regressed) surfaces as a vitest failure instead of a
    // silent unhandled rejection.
    await vi.waitFor(() => expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1));
  });
});
