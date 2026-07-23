import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingAutomationService } from '../invoices/billing-automation.service';
import type { InvoicesService } from '../invoices/invoices.service';
import type { PaymentIntentsService } from '../invoices/payment-intents.service';
import type { TicketsService } from '../tickets/tickets.service';
import { SCHEDULER_JOBS } from './scheduler.constants';
import { SchedulerProcessor } from './scheduler.processor';

describe('SchedulerProcessor', () => {
  let invoices: { run: ReturnType<typeof vi.fn> };
  let billing: { isolirOverdue: ReturnType<typeof vi.fn>; remind: ReturnType<typeof vi.fn> };
  let tickets: { scanSla: ReturnType<typeof vi.fn> };
  let paymentIntents: { expireStale: ReturnType<typeof vi.fn> };
  let processor: SchedulerProcessor;

  beforeEach(() => {
    invoices = {
      run: vi.fn().mockResolvedValue({
        period: '2026-06',
        created: 0,
        failed: 0,
        failedCustomerIds: [],
      }),
    };
    billing = {
      isolirOverdue: vi.fn().mockResolvedValue({
        markedOverdue: 0,
        isolated: 0,
        failed: 0,
        failedCustomerIds: [],
      }),
      remind: vi.fn().mockResolvedValue({ reminded: 0, channel: 'whatsapp' }),
    };
    tickets = { scanSla: vi.fn().mockResolvedValue({ breached: 0 }) };
    paymentIntents = { expireStale: vi.fn().mockResolvedValue({ expired: 0 }) };
    processor = new SchedulerProcessor(
      invoices as unknown as InvoicesService,
      billing as unknown as BillingAutomationService,
      tickets as unknown as TicketsService,
      paymentIntents as unknown as PaymentIntentsService,
    );
  });

  const run = (name: string) => processor.process({ name } as Job);

  it('routes billing.run to invoices.run', async () => {
    await run(SCHEDULER_JOBS.billingRun.name);
    expect(invoices.run).toHaveBeenCalledTimes(1);
  });

  it('routes billing.isolir-overdue to billing.isolirOverdue', async () => {
    await run(SCHEDULER_JOBS.billingIsolirOverdue.name);
    expect(billing.isolirOverdue).toHaveBeenCalledTimes(1);
  });

  // H1: a partial-batch failure inside the resilient (D7) run()/isolirOverdue()
  // must still fail the JOB so BullMQ retries + onFailed alerts fire, instead
  // of silently swallowing the dropped customers.
  it('throws when invoices.run() reports a partial-batch failure, so the job retries', async () => {
    invoices.run.mockResolvedValue({
      period: '2026-06',
      created: 2,
      failed: 1,
      failedCustomerIds: ['c9'],
    });
    await expect(run(SCHEDULER_JOBS.billingRun.name)).rejects.toThrow(/c9/);
  });

  it('does not throw when invoices.run() has zero failures', async () => {
    invoices.run.mockResolvedValue({
      period: '2026-06',
      created: 2,
      failed: 0,
      failedCustomerIds: [],
    });
    await expect(run(SCHEDULER_JOBS.billingRun.name)).resolves.toBeUndefined();
  });

  it('throws when billing.isolirOverdue() reports a partial-batch failure, so the job retries', async () => {
    billing.isolirOverdue.mockResolvedValue({
      markedOverdue: 3,
      isolated: 2,
      failed: 1,
      failedCustomerIds: ['c7'],
    });
    await expect(run(SCHEDULER_JOBS.billingIsolirOverdue.name)).rejects.toThrow(/c7/);
  });

  it('does not throw when billing.isolirOverdue() has zero failures', async () => {
    billing.isolirOverdue.mockResolvedValue({
      markedOverdue: 3,
      isolated: 3,
      failed: 0,
      failedCustomerIds: [],
    });
    await expect(run(SCHEDULER_JOBS.billingIsolirOverdue.name)).resolves.toBeUndefined();
  });

  it('routes billing.dunning to billing.remind with no explicit ids', async () => {
    await run(SCHEDULER_JOBS.billingDunning.name);
    expect(billing.remind).toHaveBeenCalledWith({});
  });

  it('routes tickets.sla-scan to tickets.scanSla', async () => {
    await run(SCHEDULER_JOBS.ticketsSlaScan.name);
    expect(tickets.scanSla).toHaveBeenCalledTimes(1);
  });

  it('routes payment-intents.expire-sweep to paymentIntents.expireStale', async () => {
    await run(SCHEDULER_JOBS.paymentIntentsExpireSweep.name);
    expect(paymentIntents.expireStale).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch on an unknown job name', async () => {
    await run('bogus.job');
    expect(invoices.run).not.toHaveBeenCalled();
    expect(billing.isolirOverdue).not.toHaveBeenCalled();
    expect(tickets.scanSla).not.toHaveBeenCalled();
    expect(paymentIntents.expireStale).not.toHaveBeenCalled();
  });
});
