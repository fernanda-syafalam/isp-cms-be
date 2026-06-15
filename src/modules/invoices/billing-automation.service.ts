import { Injectable, Logger } from '@nestjs/common';
import { CustomersRepository } from '../customers/customers.repository';
import type {
  IsolirResult,
  RemindInput,
  RemindResult,
  SchedulerPreview,
  SchedulerRunResult,
} from './dto/billing-automation.dto';
import { InvoicesRepository } from './invoices.repository';
import { InvoicesService } from './invoices.service';

// Billing-policy constants (belong in settings; documented defaults for now).
const LATE_FEE = 25_000;
const REMIND_UPCOMING_DAYS = 3;

@Injectable()
export class BillingAutomationService {
  private readonly logger = new Logger(BillingAutomationService.name);

  constructor(
    private readonly invoices: InvoicesService,
    private readonly repo: InvoicesRepository,
    private readonly customers: CustomersRepository,
  ) {}

  /** Mark overdue + apply late fee, then suspend active debtors. */
  async isolirOverdue(): Promise<IsolirResult> {
    const markedOverdue = await this.repo.markOverduePastDue(LATE_FEE);
    const isolated = await this.isolateActiveDebtors();
    this.logger.log({ markedOverdue, isolated }, 'billing isolir-overdue');
    return { markedOverdue, isolated };
  }

  /** Send dunning. With explicit ids: those unpaid; otherwise all overdue. */
  async remind(input: RemindInput): Promise<RemindResult> {
    const reminded = input.invoiceIds?.length
      ? await this.repo.markRemindedByIds(input.invoiceIds)
      : await this.repo.markRemindedOverdue();
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
    await this.repo.markOverduePastDue(LATE_FEE);
    const remindedUpcoming = await this.repo.markRemindedDueSoon(REMIND_UPCOMING_DAYS);
    const remindedOverdue = await this.repo.markRemindedOverdue();
    const isolated = await this.isolateActiveDebtors();
    this.logger.log({ period, created, isolated }, 'billing scheduler run');
    return { period, created, remindedUpcoming, remindedOverdue, isolated };
  }

  // Suspend (isolir) only currently-active customers that have an overdue
  // invoice, refreshing their outstanding balance. Returns how many moved.
  private async isolateActiveDebtors(): Promise<number> {
    const ids = await this.repo.customerIdsWithOverdue();
    let isolated = 0;
    for (const id of ids) {
      const customer = await this.customers.findById(id);
      if (customer?.status === 'aktif') {
        const outstanding = await this.repo.sumUnpaidByCustomer(id);
        await this.customers.setBilling(id, { status: 'isolir', outstanding });
        isolated += 1;
      }
    }
    return isolated;
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
