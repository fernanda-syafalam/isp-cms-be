import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { notifyBestEffort } from '../../common/notifications/notify-best-effort';
import { formatIdr } from '../../common/utils/format-idr';
import { wibDateString, wibMonthStart } from '../../common/utils/wib-date';
import type { Invoice, Payment } from '../../infrastructure/database/schema/invoices.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { ResellersRepository } from '../resellers/resellers.repository';
import { SecretEnforcementService } from '../router-resources/secret-enforcement.service';
import { SettingsService } from '../settings/settings.service';
import { SlaCreditsRepository } from '../sla-credits/sla-credits.repository';
import type { BillingRunResult } from './dto/billing-run-result.dto';
import type { InvoiceListResponse, InvoiceResponse } from './dto/invoice-response.dto';
import type { PaymentReconciliation } from './dto/payment-reconciliation.dto';
import type { PaymentResponse } from './dto/payment-response.dto';
import type { RecordPaymentInput } from './dto/record-payment.dto';
import { invoiceTotal } from './invoice-total';
import type { DbTx } from './invoices.repository';
import {
  type InvoiceListFilter,
  InvoicesRepository,
  type PaymentListFilter,
} from './invoices.repository';

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly repo: InvoicesRepository,
    // Billing owns a customer's outstanding balance + payment-driven
    // reactivation, written through the customers repository seam.
    private readonly customers: CustomersRepository,
    // Payment-driven reactivation must re-enable the PPPoE secret in the DB and on the router (ADR-0008).
    private readonly secrets: SecretEnforcementService,
    // Tax + due-days policy (P2.3) — read at run time so admin edits apply.
    private readonly settings: SettingsService,
    // Reseller commission on payment (P3.D.1, ADR-0010).
    private readonly resellers: ResellersRepository,
    // Absorbs pending SLA credits into the invoice discount (P3.A.4).
    private readonly slaCredits: SlaCreditsRepository,
    // invoice_created/paid via the retried queue (ADR-0012); best-effort, see notifyBestEffort.
    private readonly notifications: NotificationsService,
  ) {}

  async list(filter: InvoiceListFilter): Promise<InvoiceListResponse> {
    const { items, total, summary } = await this.repo.list(filter);
    return { items: items.map(toInvoiceResponse), total, summary };
  }

  async findById(id: string): Promise<InvoiceResponse> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException('invoice not found');
    return toInvoiceResponse(row);
  }

  async listPayments(
    filter: PaymentListFilter,
  ): Promise<{ items: PaymentResponse[]; total: number }> {
    const { items, total } = await this.repo.listPayments(filter);
    return { items: items.map(toPaymentResponse), total };
  }

  /** A customer's invoices, newest first — for the self-service portal. */
  async invoicesByCustomer(customerId: string): Promise<InvoiceResponse[]> {
    const rows = await this.repo.listByCustomer(customerId);
    return rows.map(toInvoiceResponse);
  }

  /** A customer's recorded payments, newest first — for the portal. */
  async paymentsByCustomer(customerId: string): Promise<PaymentResponse[]> {
    const rows = await this.repo.listPaymentsByCustomer(customerId);
    return rows.map(toPaymentResponse);
  }

  /** The loket/cash-drawer closing report for one calendar day (P3.A.4). */
  async reconciliation(date: string): Promise<PaymentReconciliation> {
    return this.repo.reconciliation(date);
  }

  /**
   * Record a payment against an invoice: full settlement or a partial slice
   * (P3.A.4). `amount` defaults to the balance due and can't exceed it; for
   * `cash`, `tenderedAmount` must cover `amount` and change is stored.
   * Reactivation from isolir and the reseller commission fire only once the
   * invoice is fully paid. Paying an already-paid invoice is a no-op.
   */
  async pay(
    id: string,
    input: RecordPaymentInput,
    // Internal only (never from the HTTP layer): see `recordPayment`'s withinTx.
    opts?: { withinTx?: (tx: DbTx) => Promise<void> },
  ): Promise<InvoiceResponse> {
    const invoice = await this.repo.findById(id);
    if (!invoice) throw new NotFoundException('invoice not found');
    if (invoice.status === 'paid') {
      return toInvoiceResponse(invoice);
    }

    const total = invoiceTotal(invoice);
    const balanceDue = total - invoice.paidAmount;
    const amount = input.amount ?? balanceDue;

    if (amount <= 0) {
      throw new BadRequestException('Jumlah pembayaran harus lebih dari nol');
    }
    if (amount > balanceDue) {
      throw new UnprocessableEntityException('Jumlah pembayaran melebihi sisa tagihan');
    }

    let tenderedAmount: number | null = null;
    let changeAmount: number | null = null;
    if (input.method === 'cash') {
      tenderedAmount = input.tenderedAmount ?? amount;
      if (tenderedAmount < amount) {
        throw new BadRequestException('Uang yang diterima kurang dari jumlah pembayaran');
      }
      changeAmount = tenderedAmount - amount;
    }

    // C2: ledger row, invoice paid_amount/status and customer outstanding commit
    // in ONE repo transaction (P3.A.4). FIN-D: a blank note is stored as null,
    // never ''.
    const note = input.note && input.note.length > 0 ? input.note : null;

    const { invoice: updated, reactivated } = await this.repo.recordPayment(
      id,
      { amount, method: input.method, tenderedAmount, changeAmount, note },
      opts?.withinTx,
    );
    // Router secret belongs to another module: runs outside the invoice/customer
    // transaction (ADR-0008).
    if (reactivated) {
      await this.reenableSecrets(invoice.customerId);
    }
    // Reactivation, commission and the 'paid' notice key off the invoice
    // reaching 'paid', never a partial payment. The notice fires after
    // recordPayment commits (ADR-0012) so a rollback can't send a false one.
    if (updated.status === 'paid') {
      await this.postResellerCommission(invoice.customerId, invoice.id, total);
      await this.notifyPaid(updated, total);
    }
    this.logger.log(
      { invoiceId: id, method: input.method, amount, status: updated.status },
      'invoice payment recorded',
    );
    return toInvoiceResponse(updated);
  }

  // The payment is already committed, so an enforcement failure must not fail it.
  // The RouterOS adapter logs router I/O errors itself; this only catches DB or
  // target-lookup failures. Nothing retries them: no reconcile job yet.
  private async reenableSecrets(customerId: string): Promise<void> {
    try {
      await this.secrets.applyDisabledForCustomer(customerId, false);
    } catch (err) {
      this.logger.error({ customerId, err }, 'secret re-enable failed after payment');
    }
  }

  /**
   * Credit the acquiring reseller's commission on a paid invoice (P3.D.1,
   * ADR-0010). Idempotent by invoice id; no-op without a reseller or with a
   * zero commission rate.
   */
  private async postResellerCommission(
    customerId: string,
    invoiceId: string,
    paidTotal: number,
  ): Promise<void> {
    const customer = await this.customers.findById(customerId);
    if (!customer?.resellerId) return;
    const reseller = await this.resellers.findById(customer.resellerId);
    if (!reseller || reseller.commissionPct <= 0) return;

    const commission = Math.round(paidTotal * reseller.commissionPct);
    if (commission <= 0) return;

    const posted = await this.resellers.postCommissionForInvoice({
      resellerId: reseller.id,
      amount: commission,
      invoiceId,
      note: `Komisi tagihan ${invoiceId}`,
    });
    if (posted) {
      this.logger.log(
        { resellerId: reseller.id, invoiceId, commission },
        'reseller commission posted',
      );
    }
  }

  /**
   * Generate this month's invoices for every active customer without one.
   * Idempotent. Due date follows the customer's `billingAnchorDay` (P3.A.4),
   * else the settings `dueDays`. Pending SLA credits become a discount line.
   */
  async run(): Promise<BillingRunResult> {
    const now = new Date();
    const { periodStart, periodEnd, periodLabel } = currentPeriod(now);
    const policy = await this.settings.getBillingPolicy();

    const billables = await this.customers.findActiveBillable();
    let created = 0;
    const failedCustomerIds: string[] = [];
    for (const customer of billables) {
      try {
        if (await this.repo.existsForPeriod(customer.id, periodStart)) continue;
        const amount = customer.planPriceMonthly;
        const taxAmount = policy.pkp ? ppnOf(amount, policy.ppnRate) : 0;
        const { discountAmount, creditIds } = await this.resolveSlaDiscount(
          customer.id,
          amount + taxAmount,
        );
        // M2: create + SLA-credit absorption + outstanding refresh are one repo
        // transaction, so a failure retries next run instead of being skipped by
        // existsForPeriod with an un-absorbed credit or stale `outstanding`.
        const invoice = await this.repo.createBilled(
          {
            customerId: customer.id,
            customerName: customer.fullName,
            periodStart,
            periodEnd,
            dueDate: dueDateFor(customer.billingAnchorDay, periodStart, now, policy.dueDays),
            amount,
            taxAmount,
            discountAmount,
            status: 'pending',
          },
          creditIds,
        );
        await this.notifyInvoiceCreated(invoice);
        created += 1;
      } catch (err) {
        // D7: one bad billable record must not abort the nightly run; record and continue.
        this.logger.error(
          { customerId: customer.id, err },
          'invoice generation failed for customer',
        );
        failedCustomerIds.push(customer.id);
      }
    }

    this.logger.log(
      { period: periodLabel, created, failed: failedCustomerIds.length },
      'billing run',
    );
    return { period: periodLabel, created, failed: failedCustomerIds.length, failedCustomerIds };
  }

  /**
   * Issue a customer's first invoice at installation time. Idempotent (the
   * work-order `complete` flow may retry); no-op for an unknown customer. Same
   * due-date and SLA-credit rules as `run()` (P3.A.4).
   */
  async generateFirstInvoice(customerId: string): Promise<void> {
    const info = await this.customers.findBillingInfo(customerId);
    if (!info) return;

    const now = new Date();
    const { periodStart, periodEnd } = currentPeriod(now);
    if (await this.repo.existsForPeriod(customerId, periodStart)) return;

    const policy = await this.settings.getBillingPolicy();
    const amount = info.planPriceMonthly;
    const taxAmount = policy.pkp ? ppnOf(amount, policy.ppnRate) : 0;
    const { discountAmount, creditIds } = await this.resolveSlaDiscount(
      customerId,
      amount + taxAmount,
    );
    // M2: single-transaction create, as in run() (see createBilled); the new
    // debt shows in `outstanding` immediately (C3).
    const invoice = await this.repo.createBilled(
      {
        customerId,
        customerName: info.fullName,
        periodStart,
        periodEnd,
        dueDate: dueDateFor(info.billingAnchorDay, periodStart, now, policy.dueDays),
        amount,
        taxAmount,
        discountAmount,
        status: 'pending',
      },
      creditIds,
    );
    await this.notifyInvoiceCreated(invoice);
    this.logger.log({ customerId }, 'first invoice generated');
  }

  /**
   * Pending SLA credits (P3.A.4) to absorb as the invoice discount, capped at
   * the gross total (amount + taxAmount) so the invoice never goes negative.
   * Returns ALL matched credit ids: every one is marked 'applied' even if the
   * sum exceeds the deduction (no carry-over to the next bill).
   */
  private async resolveSlaDiscount(
    customerId: string,
    grossTotal: number,
  ): Promise<{ discountAmount: number; creditIds: string[] }> {
    const pending = await this.slaCredits.findPendingByCustomer(customerId);
    if (pending.length === 0) return { discountAmount: 0, creditIds: [] };
    const creditSum = pending.reduce((sum, credit) => sum + credit.amount, 0);
    return {
      discountAmount: Math.min(creditSum, grossTotal),
      creditIds: pending.map((credit) => credit.id),
    };
  }

  /**
   * Notify the customer their invoice was issued (ADR-0012). jobId is per
   * invoice id; existsForPeriod guarantees one invoice per period. Best-effort:
   * see `notifyBestEffort`.
   */
  private async notifyInvoiceCreated(invoice: Invoice): Promise<void> {
    await notifyBestEffort(
      this.logger,
      async () => {
        const customer = await this.customers.findById(invoice.customerId);
        if (!customer?.phone) return;
        await this.notifications.enqueue(
          {
            event: 'invoice_created',
            to: customer.phone,
            vars: {
              nama: customer.fullName,
              no_tagihan: invoice.invoiceNo,
              jumlah: formatIdr(invoiceTotal(invoice)),
              jatuh_tempo: invoice.dueDate,
            },
          },
          `invoice_created:${invoice.id}`,
        );
      },
      { event: 'invoice_created', invoiceId: invoice.id },
    );
  }

  /**
   * Notify the customer their payment cleared the invoice in full (ADR-0012).
   * jobId is per invoice id: an invoice reaches 'paid' once (repeat calls
   * short-circuit in `pay()`, races resolve under recordPayment's `for update`
   * lock). Best-effort: see `notifyBestEffort`.
   */
  private async notifyPaid(invoice: Invoice, total: number): Promise<void> {
    await notifyBestEffort(
      this.logger,
      async () => {
        const customer = await this.customers.findById(invoice.customerId);
        if (!customer?.phone) return;
        await this.notifications.enqueue(
          {
            event: 'paid',
            to: customer.phone,
            vars: {
              nama: customer.fullName,
              no_tagihan: invoice.invoiceNo,
              jumlah: formatIdr(total),
            },
          },
          `paid:${invoice.id}`,
        );
      },
      { event: 'paid', invoiceId: invoice.id },
    );
  }
}

function ppnOf(amount: number, rate: number): number {
  return Math.round(amount * rate);
}

// --- date helpers (whole-day, WIB calendar) ----------------------------
//
// TIME-1: the basis is the WIB (Asia/Jakarta) day, not UTC. The billing cron
// fires 02:00 WIB on the 1st = 19:00 UTC on the last day of the previous month,
// so a UTC currentPeriod() would return the previous month: existsForPeriod
// would already be true, nothing would be billed, and dueDateFor would land in
// the past.

// Midnight UTC of `now`'s WIB calendar day: a pure date value, safe input for
// the getUTC* arithmetic below.
function wibDateAnchor(now: Date): Date {
  return new Date(`${wibDateString(now)}T00:00:00.000Z`);
}

function currentPeriod(now: Date): {
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
} {
  const anchor = wibDateAnchor(now);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth(); // 0-based
  const mm = String(month + 1).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return {
    periodStart: wibMonthStart(now),
    periodEnd: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
    periodLabel: `${year}-${mm}`,
  };
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDate(date: Date): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * Invoice due date (P3.A.4): the customer's `billingAnchorDay` (clamped 1..28,
 * as not every month has a 29th-31st) within the invoiced period; otherwise
 * `dueDays` after `now`'s WIB calendar day.
 */
function dueDateFor(
  billingAnchorDay: number | null,
  periodStart: string,
  now: Date,
  fallbackDueDays: number,
): string {
  if (billingAnchorDay == null) {
    // Anchor on the WIB calendar day: addDays/isoDate are getUTC* calendar math (TIME-1).
    return isoDate(addDays(wibDateAnchor(now), fallbackDueDays));
  }
  const day = Math.min(28, Math.max(1, billingAnchorDay));
  const [year, month] = periodStart.split('-'); // 'YYYY-MM-01' -> ['YYYY', 'MM', '01']
  return `${year}-${month}-${String(day).padStart(2, '0')}`;
}

function toInvoiceResponse(row: Invoice): InvoiceResponse {
  const balanceDue = Math.max(0, invoiceTotal(row) - row.paidAmount);
  return {
    id: row.id,
    invoiceNo: row.invoiceNo,
    customerId: row.customerId,
    customerName: row.customerName,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    amount: row.amount,
    lateFee: row.lateFee,
    taxAmount: row.taxAmount,
    discountAmount: row.discountAmount,
    paidAmount: row.paidAmount,
    balanceDue,
    taxInvoiceNo: row.taxInvoiceNo,
    status: row.status,
    dueDate: row.dueDate,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    lastRemindedAt: row.lastRemindedAt ? row.lastRemindedAt.toISOString() : null,
    type: row.type,
    note: row.note,
  };
}

function toPaymentResponse(row: Payment): PaymentResponse {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    invoiceNo: row.invoiceNo,
    customerId: row.customerId,
    customerName: row.customerName,
    amount: row.amount,
    method: row.method,
    source: row.source,
    voucherId: row.voucherId,
    tenderedAmount: row.tenderedAmount,
    changeAmount: row.changeAmount,
    note: row.note,
    paidAt: row.paidAt.toISOString(),
  };
}
