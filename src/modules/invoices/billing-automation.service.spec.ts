import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomersRepository } from '../customers/customers.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { SecretEnforcementService } from '../router-resources/secret-enforcement.service';
import { SettingsService } from '../settings/settings.service';
import { BillingAutomationService } from './billing-automation.service';
import { InvoicesRepository } from './invoices.repository';
import { InvoicesService } from './invoices.service';

describe('BillingAutomationService', () => {
  let service: BillingAutomationService;
  let invoicesService: { run: ReturnType<typeof vi.fn> };
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let customers: {
    findByIds: ReturnType<typeof vi.fn>;
    setBilling: ReturnType<typeof vi.fn>;
    findActiveBillable: ReturnType<typeof vi.fn>;
  };
  let secrets: { applyDisabledForCustomer: ReturnType<typeof vi.fn> };
  let notifications: { enqueue: ReturnType<typeof vi.fn> };

  // Helper: build the batched findByIds mock's Promise<CustomerRow[]> return
  // value from a plain id -> partial-row map, so each test can express "this
  // id resolves to this row" the same way it used to for findById, while a
  // deliberately-omitted id models a customer that vanished mid-run (the
  // old findById -> null case).
  const rowsFor = (byId: Record<string, Record<string, unknown>>) =>
    Object.entries(byId).map(([id, fields]) => ({ id, ...fields }));

  beforeEach(async () => {
    invoicesService = { run: vi.fn() };
    repo = {
      markOverduePastDue: vi.fn(),
      countOverdueAll: vi.fn(),
      countPendingDueSoon: vi.fn(),
      markRemindedOverdue: vi.fn(),
      markRemindedDueSoon: vi.fn(),
      markRemindedByIds: vi.fn(),
      customerIdsWithOverdue: vi.fn(),
      customerIdsIsolirEligible: vi.fn(),
      customerIdsWithPendingDueSoon: vi.fn(),
      sumUnpaidByCustomers: vi.fn(),
      existingRegularForPeriod: vi.fn(),
    };
    customers = { findByIds: vi.fn(), setBilling: vi.fn(), findActiveBillable: vi.fn() };
    secrets = { applyDisabledForCustomer: vi.fn() };
    notifications = { enqueue: vi.fn() };
    // Safe defaults so the dunning dispatch is a no-op unless a test opts in.
    repo.customerIdsWithOverdue.mockResolvedValue([]);
    // D2: isolir selection reads its own grace-filtered query, decoupled
    // from customerIdsWithOverdue (which still drives dunning).
    repo.customerIdsIsolirEligible.mockResolvedValue([]);
    repo.customerIdsWithPendingDueSoon.mockResolvedValue([]);
    customers.findByIds.mockResolvedValue([]);
    repo.sumUnpaidByCustomers.mockResolvedValue(new Map());
    const settings = {
      getBillingPolicy: vi.fn().mockResolvedValue({
        pkp: true,
        ppnRate: 0.11,
        dueDays: 10,
        lateFeeIdr: 25_000,
        isolirGraceDays: 3,
      }),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BillingAutomationService,
        { provide: InvoicesService, useValue: invoicesService },
        { provide: InvoicesRepository, useValue: repo },
        { provide: CustomersRepository, useValue: customers },
        { provide: SecretEnforcementService, useValue: secrets },
        { provide: NotificationsService, useValue: notifications },
        { provide: SettingsService, useValue: settings },
      ],
    }).compile();
    service = moduleRef.get(BillingAutomationService);
  });

  describe('isolirOverdue', () => {
    it('marks overdue then isolates only active debtors', async () => {
      repo.markOverduePastDue.mockResolvedValue(3);
      repo.customerIdsIsolirEligible.mockResolvedValue(['c1', 'c2']);
      customers.findByIds.mockResolvedValue(
        rowsFor({ c1: { status: 'aktif', phone: null }, c2: { status: 'isolir', phone: null } }),
      );
      repo.sumUnpaidByCustomers.mockResolvedValue(
        new Map([
          ['c1', 247_000],
          ['c2', 247_000],
        ]),
      );

      const result = await service.isolirOverdue();

      expect(repo.markOverduePastDue).toHaveBeenCalledWith(25_000);
      // D2: the isolir cohort is now read via the grace-filtered query.
      expect(repo.customerIdsIsolirEligible).toHaveBeenCalledWith(3);
      // c1 (aktif) gets isolated; c2 (already isolir) is skipped
      expect(customers.setBilling).toHaveBeenCalledTimes(1);
      // Auto-isolir is punitive (P3.A.3): records the overdue hold reason.
      expect(customers.setBilling).toHaveBeenCalledWith('c1', {
        status: 'isolir',
        outstanding: 247_000,
        holdReason: 'overdue',
      });
      // ADR-0008: isolating a debtor disables their PPPoE secret on the router.
      expect(secrets.applyDisabledForCustomer).toHaveBeenCalledTimes(1);
      expect(secrets.applyDisabledForCustomer).toHaveBeenCalledWith('c1', true);
      expect(result).toEqual({ markedOverdue: 3, isolated: 1, failed: 0, failedCustomerIds: [] });
    });

    // ADR-0012: the exact "overdue → isolir surprise" this ADR exists to
    // prevent — the newly-isolated customer must be told via WhatsApp.
    it('enqueues an isolir notice to each newly-isolated customer with a phone', async () => {
      repo.markOverduePastDue.mockResolvedValue(1);
      repo.customerIdsIsolirEligible.mockResolvedValue(['c1', 'c2']);
      customers.findByIds.mockResolvedValue(
        rowsFor({
          c1: { status: 'aktif', phone: '0812', fullName: 'Budi' },
          c2: { status: 'aktif', phone: null, fullName: 'Tanpa Telepon' },
        }),
      );
      repo.sumUnpaidByCustomers.mockResolvedValue(
        new Map([
          ['c1', 300_000],
          ['c2', 300_000],
        ]),
      );

      await service.isolirOverdue();

      // c1 has a phone -> enqueued; c2 has none -> skipped (still isolated).
      expect(notifications.enqueue).toHaveBeenCalledTimes(1);
      expect(notifications.enqueue).toHaveBeenCalledWith(
        { event: 'isolir', to: '0812', vars: { nama: 'Budi', jumlah: 'Rp300.000' } },
        expect.stringMatching(/^isolir:c1:/),
      );
      // c2 is still isolated even without a phone to notify.
      expect(customers.setBilling).toHaveBeenCalledTimes(2);
      expect(secrets.applyDisabledForCustomer).toHaveBeenCalledTimes(2);
    });

    // TIME-1 regression: the billing/isolir/dunning cron now fires with
    // `tz: Asia/Jakarta` (scheduler.constants.ts), so 2026-08-01 02:00 WIB —
    // the isolir cron's actual firing instant — is 2026-07-31T19:00:00Z.
    // `currentPeriodStart()` must read that as August, not July, or the
    // isolir notice's dedup jobId (and existingRegularForPeriod's lookup)
    // silently lands on the wrong billing period at every month boundary.
    it('currentPeriodStart uses the WIB calendar day, so the isolir jobId period is August at 2026-08-01 02:00 WIB (= 2026-07-31T19:00Z)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-31T19:00:00.000Z'));
      try {
        repo.markOverduePastDue.mockResolvedValue(1);
        repo.customerIdsIsolirEligible.mockResolvedValue(['c1']);
        customers.findByIds.mockResolvedValue(
          rowsFor({ c1: { status: 'aktif', phone: '0812', fullName: 'Budi' } }),
        );
        repo.sumUnpaidByCustomers.mockResolvedValue(new Map([['c1', 300_000]]));

        await service.isolirOverdue();

        expect(notifications.enqueue).toHaveBeenCalledWith(
          { event: 'isolir', to: '0812', vars: { nama: 'Budi', jumlah: 'Rp300.000' } },
          'isolir:c1:2026-08-01',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not fail the isolir run when the notification enqueue rejects (best-effort)', async () => {
      repo.markOverduePastDue.mockResolvedValue(1);
      repo.customerIdsIsolirEligible.mockResolvedValue(['c1']);
      customers.findByIds.mockResolvedValue(
        rowsFor({ c1: { status: 'aktif', phone: '0812', fullName: 'Budi' } }),
      );
      repo.sumUnpaidByCustomers.mockResolvedValue(new Map([['c1', 300_000]]));
      notifications.enqueue.mockRejectedValue(new Error('queue down'));

      const result = await service.isolirOverdue();

      // The isolir enforcement (status flip + router secret disable) still
      // completes even though the notice failed to enqueue.
      expect(result.isolated).toBe(1);
      expect(result.failed).toBe(0);
      expect(secrets.applyDisabledForCustomer).toHaveBeenCalledWith('c1', true);
    });

    // R6-DB-2 regression lock: proves the batched findByIds/sumUnpaidByCustomers
    // rewrite selects the EXACT SAME target set as the old per-id
    // findById/sumUnpaidByCustomer loop, across every branch at once — aktif
    // with a phone (isolated + notified), aktif without a phone (isolated,
    // not notified), non-aktif (skipped entirely), and an id present in the
    // overdue cohort but ABSENT from findByIds's result (simulating a
    // customer deleted mid-run) — which must behave exactly like the old
    // `findById` returning null: silently skipped, no throw.
    it('selects the exact same target set as the old per-id loop: aktif/non-aktif, phone/no-phone, and a deleted-mid-run id', async () => {
      repo.markOverduePastDue.mockResolvedValue(4);
      repo.customerIdsIsolirEligible.mockResolvedValue(['c1', 'c2', 'c3', 'c4']);
      // c4 is deliberately omitted from findByIds — models a row deleted
      // between customerIdsIsolirEligible() and the batched fetch.
      customers.findByIds.mockResolvedValue(
        rowsFor({
          c1: { status: 'aktif', phone: '0812', fullName: 'Budi' },
          c2: { status: 'aktif', phone: null, fullName: 'Tanpa Telepon' },
          c3: { status: 'isolir', phone: '0813', fullName: 'Sudah Isolir' },
        }),
      );
      repo.sumUnpaidByCustomers.mockResolvedValue(
        new Map([
          ['c1', 111_000],
          ['c2', 222_000],
          ['c3', 333_000],
        ]),
      );

      const result = await service.isolirOverdue();

      // Only c1 and c2 are aktif -> isolated. c3 (already isolir) and c4
      // (deleted) are never touched.
      expect(result.isolated).toBe(2);
      expect(customers.setBilling).toHaveBeenCalledTimes(2);
      expect(customers.setBilling).toHaveBeenCalledWith('c1', {
        status: 'isolir',
        outstanding: 111_000,
        holdReason: 'overdue',
      });
      expect(customers.setBilling).toHaveBeenCalledWith('c2', {
        status: 'isolir',
        outstanding: 222_000,
        holdReason: 'overdue',
      });
      expect(customers.setBilling).not.toHaveBeenCalledWith('c3', expect.anything());
      expect(customers.setBilling).not.toHaveBeenCalledWith('c4', expect.anything());
      // Router secret is disabled for the same 2 isolated customers.
      expect(secrets.applyDisabledForCustomer).toHaveBeenCalledTimes(2);
      expect(secrets.applyDisabledForCustomer).toHaveBeenCalledWith('c1', true);
      expect(secrets.applyDisabledForCustomer).toHaveBeenCalledWith('c2', true);
      // Only c1 has a phone -> only c1 gets a WhatsApp notice.
      expect(notifications.enqueue).toHaveBeenCalledTimes(1);
      expect(notifications.enqueue).toHaveBeenCalledWith(
        { event: 'isolir', to: '0812', vars: { nama: 'Budi', jumlah: 'Rp111.000' } },
        expect.stringMatching(/^isolir:c1:/),
      );
    });

    // D2: isolir selection must honor the configured grace period. The
    // actual dueDate + graceDays < today comparison lives in the repository
    // (see customerIdsIsolirEligible's int-spec); at the service layer we
    // lock that isolirGraceDays from settings is what gets passed through,
    // and that only the ids the (grace-filtered) query returns are ever
    // touched — a customer still within grace is never even considered.
    it('only isolates customers the grace-filtered query returns, using the configured isolirGraceDays', async () => {
      repo.markOverduePastDue.mockResolvedValue(2);
      // c1: beyond grace -> returned by the eligible query -> isolated.
      // c2: within grace -> the repo query itself excludes it, so it never
      // reaches this service at all.
      repo.customerIdsIsolirEligible.mockResolvedValue(['c1']);
      customers.findByIds.mockResolvedValue(
        rowsFor({ c1: { status: 'aktif', phone: null }, c2: { status: 'aktif', phone: null } }),
      );
      repo.sumUnpaidByCustomers.mockResolvedValue(new Map([['c1', 200_000]]));

      const result = await service.isolirOverdue();

      // isolirGraceDays comes from settings.getBillingPolicy() (3 in the
      // shared test fixture) and must reach the repository call unchanged.
      expect(repo.customerIdsIsolirEligible).toHaveBeenCalledWith(3);
      expect(customers.setBilling).toHaveBeenCalledTimes(1);
      expect(customers.setBilling).toHaveBeenCalledWith('c1', {
        status: 'isolir',
        outstanding: 200_000,
        holdReason: 'overdue',
      });
      expect(customers.setBilling).not.toHaveBeenCalledWith('c2', expect.anything());
      expect(result.isolated).toBe(1);
    });

    // D7: one bad customer record (DB write or router enforcement throwing)
    // must never abort the rest of the nightly isolir sweep — the other
    // customers still get isolated, and the failure is surfaced in `failed`
    // / `failedCustomerIds` instead of aborting the whole batch.
    it('isolates the remaining customers and reports the failure when one customer throws mid-batch', async () => {
      repo.markOverduePastDue.mockResolvedValue(3);
      repo.customerIdsIsolirEligible.mockResolvedValue(['c1', 'c2', 'c3']);
      customers.findByIds.mockResolvedValue(
        rowsFor({
          c1: { status: 'aktif', phone: null, fullName: 'Ani' },
          c2: { status: 'aktif', phone: null, fullName: 'Budi' },
          c3: { status: 'aktif', phone: null, fullName: 'Citra' },
        }),
      );
      repo.sumUnpaidByCustomers.mockResolvedValue(
        new Map([
          ['c1', 100_000],
          ['c2', 200_000],
          ['c3', 300_000],
        ]),
      );
      // c2's router enforcement fails (e.g. Mikrotik outage); c1 and c3
      // must still be isolated.
      secrets.applyDisabledForCustomer.mockImplementation((id: string) =>
        id === 'c2' ? Promise.reject(new Error('router unreachable')) : Promise.resolve(1),
      );

      const result = await service.isolirOverdue();

      expect(customers.setBilling).toHaveBeenCalledWith('c1', expect.objectContaining({}));
      expect(customers.setBilling).toHaveBeenCalledWith('c3', expect.objectContaining({}));
      // M1 (fail-closed ordering): the router disable runs BEFORE the DB
      // status flip, so a failed disable for c2 must leave c2's status
      // untouched (still 'aktif') — the next sweep's eligibility query will
      // pick c2 up again and retry, instead of a permanently-online
      // customer stuck at status='isolir'.
      expect(customers.setBilling).not.toHaveBeenCalledWith('c2', expect.anything());
      expect(result).toEqual({
        markedOverdue: 3,
        isolated: 2,
        failed: 1,
        failedCustomerIds: ['c2'],
      });
    });
  });

  describe('remind', () => {
    it('reminds explicit ids when provided', async () => {
      repo.markRemindedByIds.mockResolvedValue(2);
      const result = await service.remind({ invoiceIds: ['a', 'b'] });
      expect(repo.markRemindedByIds).toHaveBeenCalledWith(['a', 'b']);
      expect(repo.markRemindedOverdue).not.toHaveBeenCalled();
      expect(result).toEqual({ reminded: 2, channel: 'whatsapp' });
    });

    // ADR-0012: dunning must actually send — enqueue one WhatsApp per overdue
    // debtor (idempotent per customer + event + month), skipping phoneless rows.
    it('enqueues a WhatsApp dunning to each overdue debtor with a phone', async () => {
      repo.markRemindedOverdue.mockResolvedValue(2);
      repo.customerIdsWithOverdue.mockResolvedValue(['c1', 'c2']);
      customers.findByIds.mockResolvedValue(
        rowsFor({ c1: { phone: '0812', fullName: 'Budi' }, c2: { phone: null, fullName: 'X' } }),
      );
      repo.sumUnpaidByCustomers.mockResolvedValue(
        new Map([
          ['c1', 247_000],
          ['c2', 247_000],
        ]),
      );

      await service.remind({});

      // c1 has a phone -> enqueued with real vars; c2 has none -> skipped.
      expect(notifications.enqueue).toHaveBeenCalledTimes(1);
      expect(notifications.enqueue).toHaveBeenCalledWith(
        { event: 'overdue', to: '0812', vars: { nama: 'Budi', jumlah: 'Rp247.000' } },
        expect.stringMatching(/^dun:overdue:c1:/),
      );
    });

    it('reminds all overdue when no ids given', async () => {
      repo.markRemindedOverdue.mockResolvedValue(5);
      const result = await service.remind({});
      expect(repo.markRemindedOverdue).toHaveBeenCalled();
      expect(result.reminded).toBe(5);
    });

    // C1 follow-up (PR #109 review): dispatchDunning was the one notification
    // emit NOT wrapped best-effort — a queue outage must never abort dunning.
    it('does not fail the reminder run when the notification enqueue rejects (best-effort)', async () => {
      repo.markRemindedOverdue.mockResolvedValue(1);
      repo.customerIdsWithOverdue.mockResolvedValue(['c1']);
      customers.findByIds.mockResolvedValue(rowsFor({ c1: { phone: '0812', fullName: 'Budi' } }));
      repo.sumUnpaidByCustomers.mockResolvedValue(new Map([['c1', 247_000]]));
      notifications.enqueue.mockRejectedValue(new Error('queue down'));

      const result = await service.remind({});

      // The reminder marking still completes even though the WhatsApp
      // notice failed to enqueue.
      expect(result).toEqual({ reminded: 1, channel: 'whatsapp' });
    });

    // R6-DB-2 regression lock for dispatchDunning: a customer id in the
    // overdue cohort but absent from the batched findByIds (deleted
    // mid-run) must be skipped exactly like the old findById -> null did —
    // no throw, no enqueue — while phoned/phoneless siblings are handled
    // independently.
    it('skips a customer id missing from the batched findByIds (deleted mid-run) without throwing', async () => {
      repo.markRemindedOverdue.mockResolvedValue(3);
      repo.customerIdsWithOverdue.mockResolvedValue(['c1', 'c2', 'c3']);
      // c3 is omitted — simulates a row deleted between
      // customerIdsWithOverdue() and the batched fetch.
      customers.findByIds.mockResolvedValue(
        rowsFor({
          c1: { phone: '0812', fullName: 'Budi' },
          c2: { phone: null, fullName: 'Tanpa Telepon' },
        }),
      );
      repo.sumUnpaidByCustomers.mockResolvedValue(
        new Map([
          ['c1', 50_000],
          ['c2', 60_000],
          ['c3', 70_000],
        ]),
      );

      const result = await service.remind({});

      expect(result).toEqual({ reminded: 3, channel: 'whatsapp' });
      // Only c1 (has a phone and is present) gets a notice.
      expect(notifications.enqueue).toHaveBeenCalledTimes(1);
      expect(notifications.enqueue).toHaveBeenCalledWith(
        { event: 'overdue', to: '0812', vars: { nama: 'Budi', jumlah: 'Rp50.000' } },
        expect.stringMatching(/^dun:overdue:c1:/),
      );
    });
  });

  it('schedulerPreview counts to-bill (active without current invoice), dunning + isolir', async () => {
    customers.findActiveBillable.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    repo.existingRegularForPeriod.mockResolvedValue(new Set(['c2']));
    repo.countPendingDueSoon.mockResolvedValue(4);
    repo.countOverdueAll.mockResolvedValue(6);
    repo.customerIdsWithOverdue.mockResolvedValue(['c1']);
    customers.findByIds.mockResolvedValue(rowsFor({ c1: { status: 'aktif' } }));

    const result = await service.schedulerPreview();
    expect(result).toEqual({ toBill: 1, toRemindUpcoming: 4, toRemindOverdue: 6, toIsolir: 1 });
  });

  it('schedulerRun chains run -> overdue -> dun -> isolir', async () => {
    invoicesService.run.mockResolvedValue({
      period: '2026-06',
      created: 7,
      failed: 0,
      failedCustomerIds: [],
    });
    repo.markOverduePastDue.mockResolvedValue(2);
    repo.markRemindedDueSoon.mockResolvedValue(3);
    repo.markRemindedOverdue.mockResolvedValue(2);
    repo.customerIdsWithOverdue.mockResolvedValue([]);

    const result = await service.schedulerRun();
    expect(result).toEqual({
      period: '2026-06',
      created: 7,
      billingFailed: 0,
      remindedUpcoming: 3,
      remindedOverdue: 2,
      isolated: 0,
      isolationFailed: 0,
    });
  });

  // C1 follow-up: a dunning queue outage must never abort the rest of the
  // scheduled run — the invoices already created by invoices.run() (and the
  // overdue/reminded marks) must still be reported back.
  it('schedulerRun still completes (invoices created, marks recorded) when every dunning enqueue rejects', async () => {
    invoicesService.run.mockResolvedValue({
      period: '2026-06',
      created: 7,
      failed: 0,
      failedCustomerIds: [],
    });
    repo.markOverduePastDue.mockResolvedValue(2);
    repo.markRemindedDueSoon.mockResolvedValue(3);
    repo.markRemindedOverdue.mockResolvedValue(2);
    repo.customerIdsWithOverdue.mockResolvedValue(['c1']);
    repo.customerIdsWithPendingDueSoon.mockResolvedValue(['c2']);
    // findByIds/sumUnpaidByCustomers must echo back a row for WHATEVER ids
    // are requested (dispatchDunning is called once per cohort — ['c2'] for
    // due_soon, ['c1'] for overdue — then isolateActiveDebtors calls it
    // again with ['c1']), same phone/fullName/amount for every id, mirroring
    // the old findById/sumUnpaidByCustomer mocks that resolved to a fixed
    // value regardless of the id passed in.
    customers.findByIds.mockImplementation((ids: string[]) =>
      Promise.resolve(ids.map((id) => ({ id, phone: '0812', fullName: 'Budi' }))),
    );
    repo.sumUnpaidByCustomers.mockImplementation((ids: string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, 100_000]))),
    );
    notifications.enqueue.mockRejectedValue(new Error('queue down'));

    const result = await service.schedulerRun();

    expect(invoicesService.run).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      period: '2026-06',
      created: 7,
      billingFailed: 0,
      remindedUpcoming: 3,
      remindedOverdue: 2,
      isolated: 0,
      isolationFailed: 0,
    });
  });
});
