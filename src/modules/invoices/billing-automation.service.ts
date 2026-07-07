import { Injectable, Logger } from '@nestjs/common';
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

  /** Mark overdue + apply late fee, then suspend active debtors. */
  async isolirOverdue(): Promise<IsolirResult> {
    const { lateFeeIdr } = await this.settings.getBillingPolicy();
    const markedOverdue = await this.repo.markOverduePastDue(lateFeeIdr);
    const isolated = await this.isolateActiveDebtors();
    this.logger.log({ markedOverdue, isolated }, 'billing isolir-overdue');
    return { markedOverdue, isolated };
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
    let toBill = 0;
    for (const c of billables) {
      if (!(await this.repo.existsForPeriod(c.id, periodStart))) toBill += 1;
    }
    return {
      toBill,
      toRemindUpcoming: await this.repo.countPendingDueSoon(REMIND_UPCOMING_DAYS),
      toRemindOverdue: await this.repo.countOverdueAll(),
      toIsolir: await this.countActiveDebtors(),
    };
  }

  /** Run the full cycle: bill -> mark overdue -> dun -> auto-isolir. */
  async schedulerRun(): Promise<SchedulerRunResult> {
    const { period, created } = await this.invoices.run();
    const { lateFeeIdr } = await this.settings.getBillingPolicy();
    await this.repo.markOverduePastDue(lateFeeIdr);
    const remindedUpcoming = await this.repo.markRemindedDueSoon(REMIND_UPCOMING_DAYS);
    const remindedOverdue = await this.repo.markRemindedOverdue();
    // Dispatch the actual WhatsApp dunning for both cohorts (ADR-0012).
    await this.dispatchDunning(
      'due_soon',
      await this.repo.customerIdsWithPendingDueSoon(REMIND_UPCOMING_DAYS),
    );
    await this.dispatchDunning('overdue', await this.repo.customerIdsWithOverdue());
    const isolated = await this.isolateActiveDebtors();
    this.logger.log({ period, created, isolated }, 'billing scheduler run');
    return { period, created, remindedUpcoming, remindedOverdue, isolated };
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
    for (const id of customerIds) {
      const customer = await this.customers.findById(id);
      if (!customer?.phone) continue;
      const outstanding = await this.repo.sumUnpaidByCustomer(id);
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

  // Suspend (isolir) only currently-active customers that have an overdue
  // invoice, refreshing their outstanding balance. Returns how many moved.
  private async isolateActiveDebtors(): Promise<number> {
    const ids = await this.repo.customerIdsWithOverdue();
    const period = currentPeriodStart();
    let isolated = 0;
    for (const id of ids) {
      const customer = await this.customers.findById(id);
      if (customer?.status === 'aktif') {
        const outstanding = await this.repo.sumUnpaidByCustomer(id);
        await this.customers.setBilling(id, {
          status: 'isolir',
          outstanding,
          holdReason: 'overdue',
        });
        // Enforce on the router: disable the customer's PPPoE secret (ADR-0008).
        await this.secrets.applyDisabledForCustomer(id, true);
        // The exact "overdue → isolir surprise" ADR-0012 was written to
        // prevent: tell the customer they were just cut off. jobId is per
        // customer + month, same granularity as dispatchDunning, so a
        // re-run of this cycle never double-sends. Skip phoneless rows,
        // same as dispatchDunning.
        if (customer.phone) {
          await this.notifyIsolir(id, customer.fullName, customer.phone, outstanding, period);
        }
        isolated += 1;
      }
    }
    return isolated;
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
    let n = 0;
    for (const id of ids) {
      const customer = await this.customers.findById(id);
      if (customer?.status === 'aktif') n += 1;
    }
    return n;
  }
}

function currentPeriodStart(): string {
  const now = new Date();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${mm}-01`;
}

// Whole-rupiah formatting for dunning message variables, e.g. "Rp250.000".
function formatIdr(amount: number): string {
  return `Rp${amount.toLocaleString('id-ID')}`;
}
