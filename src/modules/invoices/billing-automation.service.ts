import { Injectable, Logger } from '@nestjs/common';
import { formatIdr } from '../../common/utils/format-idr';
import { wibDateString } from '../../common/utils/wib-date';
import { CustomersRepository } from '../customers/customers.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { SecretEnforcementService } from '../router-resources/secret-enforcement.service';
import { SettingsService } from '../settings/settings.service';
import type {
  IsolirResult,
  RemindInput,
  RemindResult,
  SchedulerPreview,
  SchedulerRunResult,
} from './dto/billing-automation.dto';
import { InvoicesRepository } from './invoices.repository';
import { InvoicesService } from './invoices.service';

// Late fee now comes from settings (P2.3). REMIND_UPCOMING_DAYS has no
// settings column yet, so it stays a documented default.
const REMIND_UPCOMING_DAYS = 3;

@Injectable()
export class BillingAutomationService {
  private readonly logger = new Logger(BillingAutomationService.name);

  constructor(
    private readonly invoices: InvoicesService,
    private readonly repo: InvoicesRepository,
    private readonly customers: CustomersRepository,
    // Auto-isolir must cut network access, not just flip the DB status
    // (ADR-0008 / P2.5): DB write + push to the router via the adapter.
    private readonly secrets: SecretEnforcementService,
    // Dunning must actually send, via the retried queue, not just stamp
    // lastRemindedAt (ADR-0012).
    private readonly notifications: NotificationsService,
    // Late-fee policy (P2.3) — read at run time so admin edits apply.
    private readonly settings: SettingsService,
  ) {}

  /** Mark overdue + apply late fee, then suspend active debtors past grace. */
  async isolirOverdue(): Promise<IsolirResult> {
    const { lateFeeIdr, isolirGraceDays } = await this.settings.getBillingPolicy();
    const markedOverdue = await this.repo.markOverduePastDue(lateFeeIdr);
    const { isolated, failed, failedCustomerIds } =
      await this.isolateActiveDebtors(isolirGraceDays);
    this.logger.log({ markedOverdue, isolated, failed }, 'billing isolir-overdue');
    return { markedOverdue, isolated, failed, failedCustomerIds };
  }

  /** Send dunning. With explicit ids: those unpaid; otherwise all overdue. */
  async remind(input: RemindInput): Promise<RemindResult> {
    const reminded = input.invoiceIds?.length
      ? await this.repo.markRemindedByIds(input.invoiceIds)
      : await this.repo.markRemindedOverdue();
    // Stamping lastRemindedAt is the audit trail; the actual WhatsApp goes to
    // the overdue debtors via the queue (ADR-0012).
    await this.dispatchDunning('overdue', await this.repo.customerIdsWithOverdue());
    return { reminded, channel: 'whatsapp' };
  }

  /** Read-only forecast of the next automated cycle. */
  async schedulerPreview(): Promise<SchedulerPreview> {
    const periodStart = currentPeriodStart();
    const billables = await this.customers.findActiveBillable();
    // R6-DB-5: one batched existence query instead of one per billable
    // customer — same type='regular' + periodStart filter as the per-id
    // existsForPeriod this replaces (see existingRegularForPeriod's doc).
    const existing = await this.repo.existingRegularForPeriod(
      billables.map((c) => c.id),
      periodStart,
    );
    const toBill = billables.filter((c) => !existing.has(c.id)).length;
    return {
      toBill,
      toRemindUpcoming: await this.repo.countPendingDueSoon(REMIND_UPCOMING_DAYS),
      toRemindOverdue: await this.repo.countOverdueAll(),
      toIsolir: await this.countActiveDebtors(),
    };
  }

  /** Run the full cycle: bill -> mark overdue -> dun -> auto-isolir. */
  async schedulerRun(): Promise<SchedulerRunResult> {
    const { period, created, failed: billingFailed } = await this.invoices.run();
    const { lateFeeIdr, isolirGraceDays } = await this.settings.getBillingPolicy();
    await this.repo.markOverduePastDue(lateFeeIdr);
    const remindedUpcoming = await this.repo.markRemindedDueSoon(REMIND_UPCOMING_DAYS);
    const remindedOverdue = await this.repo.markRemindedOverdue();
    // Dispatch the actual WhatsApp dunning for both cohorts (ADR-0012).
    await this.dispatchDunning(
      'due_soon',
      await this.repo.customerIdsWithPendingDueSoon(REMIND_UPCOMING_DAYS),
    );
    await this.dispatchDunning('overdue', await this.repo.customerIdsWithOverdue());
    const { isolated, failed: isolationFailed } = await this.isolateActiveDebtors(isolirGraceDays);
    this.logger.log(
      { period, created, billingFailed, isolated, isolationFailed },
      'billing scheduler run',
    );
    return {
      period,
      created,
      billingFailed,
      remindedUpcoming,
      remindedOverdue,
      isolated,
      isolationFailed,
    };
  }

  // Enqueue one WhatsApp dunning message per customer in the cohort. The job id
  // is per customer + event + month, so re-running the cycle never double-sends
  // (BullMQ rejects the duplicate jobId). Customers without a phone are skipped.
  // Best-effort (C1 follow-up to ADR-0012): a queue outage for one customer's
  // notice must never abort the rest of the cohort or the billing run that
  // already committed the overdue/due-soon marking — log and swallow rather
  // than rethrow, same resilience as notifyIsolir below.
  private async dispatchDunning(
    event: 'due_soon' | 'overdue',
    customerIds: string[],
  ): Promise<void> {
    const period = currentPeriodStart();
    // R6-DB-2: two batched round-trips (customers + outstanding sums) up
    // front instead of two per customer id in the loop below. A customer id
    // present in customerIds but absent from the batched fetch (e.g.
    // deleted mid-run) behaves exactly like the old findById -> null did:
    // `customersById.get(id)` is undefined, so the phone-skip guard below
    // (`!customer?.phone`) skips it the same way.
    const [customersRows, outstandingByCustomer] = await Promise.all([
      this.customers.findByIds(customerIds),
      this.repo.sumUnpaidByCustomers(customerIds),
    ]);
    const customersById = new Map(customersRows.map((c) => [c.id, c]));
    for (const id of customerIds) {
      const customer = customersById.get(id);
      if (!customer?.phone) continue;
      // Missing key = no unpaid invoices = 0, mirroring sumUnpaidByCustomer's
      // own coalesce(...,0) for a single id (see sumUnpaidByCustomers' doc).
      const outstanding = outstandingByCustomer.get(id) ?? 0;
      try {
        await this.notifications.enqueue(
          {
            event,
            to: customer.phone,
            // Real per-recipient template variables (P2.2) — no more SAMPLE_VARS.
            vars: { nama: customer.fullName, jumlah: formatIdr(outstanding) },
          },
          `dun:${event}:${id}:${period}`,
        );
      } catch (err) {
        this.logger.warn({ customerId: id, event, err }, 'dunning notification enqueue failed');
      }
    }
  }

  // Suspend (isolir) only currently-active customers whose oldest overdue
  // invoice is past due by more than the configured grace period (D2),
  // refreshing their outstanding balance. Returns how many moved, plus how
  // many failed (D7: one bad record must never abort the rest of the sweep).
  private async isolateActiveDebtors(
    graceDays: number,
  ): Promise<{ isolated: number; failed: number; failedCustomerIds: string[] }> {
    const ids = await this.repo.customerIdsIsolirEligible(graceDays);
    const period = currentPeriodStart();
    // R6-DB-2: same batched-fetch-then-loop-side-effects shape as
    // dispatchDunning above. A deleted-mid-run id is simply absent from
    // customersById, so `customer?.status === 'aktif'` is false and it's
    // skipped — identical to the old findById -> null behavior.
    const [customersRows, outstandingByCustomer] = await Promise.all([
      this.customers.findByIds(ids),
      this.repo.sumUnpaidByCustomers(ids),
    ]);
    const customersById = new Map(customersRows.map((c) => [c.id, c]));
    let isolated = 0;
    const failedCustomerIds: string[] = [];
    for (const id of ids) {
      const customer = customersById.get(id);
      if (customer?.status !== 'aktif') continue;
      try {
        // Missing key = 0, mirroring sumUnpaidByCustomer's coalesce(...,0).
        const outstanding = outstandingByCustomer.get(id) ?? 0;
        // M1 (fail-closed ordering): enforce on the router BEFORE flipping
        // the DB status. If applyDisabledForCustomer throws (e.g. a
        // Mikrotik outage), the customer is left status='aktif' — the next
        // sweep's customerIdsIsolirEligible/`status === 'aktif'` check picks
        // them up again and retries the disable. The old order (DB flip
        // first) could leave a customer status='isolir' but still online
        // forever, since every later sweep's `status === 'aktif'` guard
        // would skip them (ADR-0008).
        await this.secrets.applyDisabledForCustomer(id, true);
        await this.customers.setBilling(id, {
          status: 'isolir',
          outstanding,
          holdReason: 'overdue',
        });
        // The exact "overdue → isolir surprise" ADR-0012 was written to
        // prevent: tell the customer they were just cut off. jobId is per
        // customer + month, same granularity as dispatchDunning, so a
        // re-run of this cycle never double-sends. Skip phoneless rows,
        // same as dispatchDunning.
        if (customer.phone) {
          await this.notifyIsolir(id, customer.fullName, customer.phone, outstanding, period);
        }
        isolated += 1;
      } catch (err) {
        // D7: a single customer's DB write or router enforcement failing
        // (e.g. a Mikrotik outage) must never abort the rest of the nightly
        // isolir sweep — log, record the failure, and continue.
        this.logger.error({ customerId: id, err }, 'isolir enforcement failed for customer');
        failedCustomerIds.push(id);
      }
    }
    return { isolated, failed: failedCustomerIds.length, failedCustomerIds };
  }

  // Best-effort (ADR-0012): a queue outage must never abort the isolir
  // enforcement that already committed (status flip + router secret
  // disable above) — log and swallow rather than rethrow. Same resilience
  // as dispatchDunning above (C1 follow-up made that best-effort too).
  private async notifyIsolir(
    customerId: string,
    fullName: string,
    phone: string,
    outstanding: number,
    period: string,
  ): Promise<void> {
    try {
      await this.notifications.enqueue(
        {
          event: 'isolir',
          to: phone,
          vars: { nama: fullName, jumlah: formatIdr(outstanding) },
        },
        `isolir:${customerId}:${period}`,
      );
    } catch (err) {
      this.logger.warn({ customerId, err }, 'isolir notification enqueue failed');
    }
  }

  private async countActiveDebtors(): Promise<number> {
    const ids = await this.repo.customerIdsWithOverdue();
    // R6-DB-2: one batched fetch instead of one findById per id — a
    // deleted-mid-run id is absent from the map, same as the old
    // findById -> null skip.
    const customersRows = await this.customers.findByIds(ids);
    return customersRows.filter((c) => c.status === 'aktif').length;
  }
}

// TIME-1 (corrected — see the CONFIRMED bug this replaced): this MUST be
// the WIB calendar day, not UTC. The billing/isolir/dunning cron
// (scheduler.constants.ts) now fires with `tz: Asia/Jakarta` — e.g. the
// billing run fires 02:00 WIB on the 1st, which is 19:00 UTC on the LAST
// day of the previous month. A UTC-based getUTCMonth()/getUTCFullYear()
// read at that exact instant returns the PREVIOUS month, so the isolir
// jobId's period (and any lookup keyed on it) would silently land on the
// wrong billing period at every month boundary. Using wibDateString(now)
// instead reads the period the cron itself intends: the WIB calendar day
// it just fired on.
//
// This value is only ever used to build a dedup jobId
// ("dun:<event>:<id>:<period>" / "isolir:<id>:<period>") and to look up
// existingRegularForPeriod against invoices.service.ts's
// InvoicesService.run()/currentPeriod() — see that file's doc comment,
// which is now ALSO WIB-based. Both sides must stay on the same basis (WIB)
// or a period rollover could double-send a dunning notice or miss an
// existing-invoice check.
function currentPeriodStart(): string {
  const [year, month] = wibDateString(new Date()).split('-');
  return `${year}-${month}-01`;
}
