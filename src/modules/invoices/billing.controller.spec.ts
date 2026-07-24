import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingAutomationService } from './billing-automation.service';
import { BillingController } from './billing.controller';
import { InvoicesService } from './invoices.service';

/**
 * H1 regression lock: the resilient (D7) service methods return a result
 * object with `failed`/`failedCustomerIds` instead of throwing when part of
 * a batch fails. `SchedulerProcessor` (the BullMQ path) deliberately
 * re-throws on `failed > 0` so the job retries + `onFailed` alerts — but
 * that decision lives ONLY in the processor. `BillingController` (the
 * manual HTTP path, `POST /v1/billing/*`) is a thin pass-through and MUST
 * NOT replicate that throw: an operator calling these routes needs to see
 * the partial-failure detail in the response body, not an opaque 5xx that
 * hides which customers failed. This spec proves the controller returns
 * the service's result as-is, in both the all-succeeded and the
 * partial-failure case.
 */
describe('BillingController', () => {
  let controller: BillingController;
  let invoices: { run: ReturnType<typeof vi.fn> };
  let automation: {
    isolirOverdue: ReturnType<typeof vi.fn>;
    schedulerRun: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    invoices = { run: vi.fn() };
    automation = { isolirOverdue: vi.fn(), schedulerRun: vi.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [
        { provide: InvoicesService, useValue: invoices },
        { provide: BillingAutomationService, useValue: automation },
      ],
    }).compile();
    controller = moduleRef.get(BillingController);
  });

  describe('run (POST /v1/billing/run)', () => {
    it('returns the result object as-is when every customer billed cleanly', async () => {
      const result = { period: '2026-07', created: 5, failed: 0, failedCustomerIds: [] };
      invoices.run.mockResolvedValue(result);

      await expect(controller.run()).resolves.toEqual(result);
    });

    // H1: a partial-batch failure must still resolve — NOT throw — through
    // the HTTP path, with `failed`/`failedCustomerIds` visible to the caller.
    it('returns the result object as-is (not a thrown error) when invoices.run() reports a partial-batch failure', async () => {
      const result = {
        period: '2026-07',
        created: 4,
        failed: 1,
        failedCustomerIds: ['c9'],
      };
      invoices.run.mockResolvedValue(result);

      await expect(controller.run()).resolves.toEqual(result);
    });
  });

  describe('isolirOverdue (POST /v1/billing/isolir-overdue)', () => {
    it('returns the result object as-is when every debtor is isolated cleanly', async () => {
      const result = { markedOverdue: 3, isolated: 3, failed: 0, failedCustomerIds: [] };
      automation.isolirOverdue.mockResolvedValue(result);

      await expect(controller.isolirOverdue()).resolves.toEqual(result);
    });

    // H1: same guarantee as run() above — the manual isolir sweep must
    // surface partial failures in the response, not as a 5xx.
    it('returns the result object as-is (not a thrown error) when isolirOverdue() reports a partial-batch failure', async () => {
      const result = {
        markedOverdue: 3,
        isolated: 2,
        failed: 1,
        failedCustomerIds: ['c7'],
      };
      automation.isolirOverdue.mockResolvedValue(result);

      await expect(controller.isolirOverdue()).resolves.toEqual(result);
    });
  });

  describe('schedulerRun (POST /v1/billing/scheduler/run)', () => {
    it('returns the result object as-is (not a thrown error) when the aggregated cycle reports partial failures', async () => {
      const result = {
        period: '2026-07',
        created: 4,
        billingFailed: 1,
        remindedUpcoming: 2,
        remindedOverdue: 1,
        isolated: 2,
        isolationFailed: 1,
      };
      automation.schedulerRun.mockResolvedValue(result);

      await expect(controller.schedulerRun()).resolves.toEqual(result);
    });
  });
});
