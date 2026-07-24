import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { notifyBestEffort } from '../../common/notifications/notify-best-effort';
import { formatIdr } from '../../common/utils/format-idr';
import { wibDateString } from '../../common/utils/wib-date';
import type { Invoice, Payment } from '../../infrastructure/database/schema/invoices.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { ResellersRepository } from '../resellers/resellers.repository';
import { SecretsRepository } from '../router-resources/secrets.repository';
import { SettingsService } from '../settings/settings.service';
import { SlaCreditsRepository } from '../sla-credits/sla-credits.repository';
import type { BillingRunResult } from './dto/billing-run-result.dto';
import type { InvoiceListResponse, InvoiceResponse } from './dto/invoice-response.dto';
import type { PaymentReconciliation } from './dto/payment-reconciliation.dto';
import type { PaymentResponse } from './dto/payment-response.dto';
import type { RecordPaymentInput } from './dto/record-payment.dto';
import {
  type InvoiceListFilter,
  InvoicesRepository,
  type PaymentListFilter,
} from './invoices.repository';

// Billing policy now comes from SettingsService (P2.3) — an admin edit in
// Settings changes the next run. The constants below survive only as the
// documented defaults, seeded into app_settings on first read.

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly repo: InvoicesRepository,
    // Billing owns a customer's outstanding balance + payment-driven
    // reactivation, written through the customers repository seam.
    private readonly customers: CustomersRepository,
    // Payment-driven reactivation must re-enable the PPPoE secret (ADR-0008).
    private readonly secrets: SecretsRepository,
    // Tax + due-days policy (P2.3) — read at run time so admin edits apply.
    private readonly settings: SettingsService,
    // Reseller commission on payment (P3.D.1, ADR-0010).
    private readonly resellers: ResellersRepository,
    // A billing run absorbs a customer's pending SLA credits into the new
    // invoice's discount line (P3.A.4).
    private readonly slaCredits: SlaCreditsRepository,
    // Fires invoice_created/paid via the retried queue (ADR-0012). Best-effort:
    // see notifyBestEffort — a notification failure must never break billing.
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
   * Record a payment against an invoice — full settlement or a partial /
   * instalment slice (P3.A.4). `amount` defaults to the full balance due;
   * it can never exceed it. For `method: 'cash'`, `tenderedAmount` must
   * cover `amount` and the change is computed and stored. Writes the ledger
   * entry, applies it to the invoice (flips to 'partial' or 'paid'), then
   * refreshes the customer's outstanding balance. Reactivation from isolir
   * and the reseller commission only fire once the invoice is fully paid —
   * a partial payment leaves the customer in debt and the secret disabled.
   * Paying an already-paid invoice is a no-op (no duplicate ledger entry).
   */
  async pay(id: string, input: RecordPaymentInput): Promise<InvoiceResponse> {
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

    // C2: the ledger row, the invoice's paid_amount/status flip, and the
    // customer's outstanding refresh all land in ONE DB transaction inside
    // the repository — a failure partway through rolls everything back, so
    // a 'paid' invoice can never exist without its payments row (P3.A.4).
    const { invoice: updated, reactivated } = await this.repo.recordPayment(id, {
      amount,
      method: input.method,
      tenderedAmount,
      changeAmount,
    });
    // Reactivation re-enables the PPPoE secret on the router (ADR-0008) —
    // a different module's repository, so it stays outside the invoice/
    // customer transaction above.
    if (reactivated) {
      await this.secrets.setDisabledByCustomerId(invoice.customerId, false);
    }
    // Reactivation + commission + the 'paid' notice are all keyed off the
    // invoice actually reaching 'paid' — a partial payment must never
    // trigger any of them. The notice fires AFTER recordPayment's
    // transaction has already committed (ADR-0012) — never inside it, so a
    // rolled-back payment can never send a false "paid" message.
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

  /**
   * Credit the acquiring reseller's commission on a paid invoice (P3.D.1,
   * ADR-0010). Idempotent by invoice id, so a re-paid/retried settlement
   * never double-credits. No-op when the customer has no reseller or the
   * reseller's commission rate is zero.
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
   * Generate this month's invoices for every active customer that does
   * not already have one. Idempotent: a re-run creates nothing. Due date
   * honors the customer's `billingAnchorDay` (P3.A.4) when set, else falls
   * back to the settings `dueDays` policy. Any of the customer's pending
   * SLA credits are absorbed as a discount line on the new invoice.
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
        // M2: create + SLA-credit absorption + the outstanding refresh all
        // land in ONE DB transaction inside the repository (mirrors `pay()`'s
        // C2 comment above) — a failure partway through rolls the invoice
        // back entirely, so this customer is retried on the next run instead
        // of being permanently skipped by `existsForPeriod` with an
        // un-absorbed credit or a stale `outstanding`.
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
        // D7: one bad billable record (e.g. a stale plan reference) must
        // never abort the rest of the nightly billing run — log, record the
        // failure, and continue with the next customer.
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
   * Issue a customer's first invoice at installation time. Idempotent:
   * skips if one already exists for the current period (the work-order
   * `complete` flow may be retried). No-op if the customer is unknown. Same
   * due-date and SLA-credit-absorption rules as `run()` (P3.A.4).
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
    // M2: same single-transaction create as run() above — see createBilled's
    // doc. An onboarded/first-billed customer must show their new debt
    // immediately (C3), and a mid-way failure must never leave a committed
    // invoice with an un-absorbed credit or a stale `outstanding`.
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
   * How much of a customer's pending SLA credits (P3.A.4) to absorb as this
   * invoice's discount line, capped at the invoice's gross total (amount +
   * taxAmount) so a discount can never make the invoice negative. Returns
   * every matched credit id — ALL of them get marked 'applied' once the
   * invoice exists, even if their combined amount exceeds what was actually
   * deducted (a documented simplification: no carry-over to the next bill).
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
   * Notify the customer their invoice was just issued (ADR-0012). jobId is
   * per invoice id — `run()`/`generateFirstInvoice()` only ever create an
   * invoice once per period (guarded by `existsForPeriod`), so this can
   * never double-fire for the same bill. Best-effort: a queue outage must
   * never fail a billing run (see `notifyBestEffort`).
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
   * Notify the customer their payment cleared the invoice in full
   * (ADR-0012). Only called once `updated.status === 'paid'` — never for a
   * partial payment. jobId is per invoice id: an invoice can only reach
   * 'paid' once (repeat calls short-circuit at the top of `pay()`, and a
   * concurrent race resolves to a single winner inside `recordPayment`'s
   * `for update` lock), so no period/payment-id component is needed for
   * idempotency. Best-effort: see `notifyBestEffort`.
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
// TIME-1 (corrected — see the CONFIRMED bug this replaced): this basis is
// deliberately the WIB (Asia/Jakarta) calendar day, NOT UTC. It used to be
// UTC and that was itself deliberate — until the billing/isolir/dunning
// cron (scheduler.constants.ts) started firing with `tz: Asia/Jakarta`.
// The billing run fires 02:00 WIB on the 1st, which is 19:00 UTC on the
// LAST day of the previous month — a UTC-based `currentPeriod()` read at
// that exact instant would return the PREVIOUS month: `existsForPeriod`
// would already be true (idempotency check for a period that never
// actually got billed), 0 invoices would be created, and `dueDateFor`
// would derive a due date in the past, making the (non-existent) invoice
// immediately overdue/isolir-eligible. Every function below goes through
// `wibDateString`/a WIB calendar-day anchor instead of raw `getUTC*` on
// `now` for exactly this reason.
//
// billing-automation.service.ts's currentPeriodStart() MUST stay on this
// same WIB basis — see that function's doc comment. Both sides must agree
// with each other AND with the WIB cron trigger, the WIB Postgres session
// `current_date` (drizzle.service.ts), and the WIB grace/aging math
// (wib-date.ts) — moving only one of them out of sync reintroduces this
// bug in a different shape.
//
// Pre-go-live note: no production invoices exist yet, so this is not a
// data migration — it only changes how *future* dueDate/periodStart
// values are computed, which is TIME-1's whole intent.

// Midnight UTC representing `now`'s WIB calendar day — a pure calendar-date
// value (no time-of-day), safe input for the getUTC*-based arithmetic below
// (`addDays`/`isoDate`/`Date.UTC`), which only ever needs to reason about
// calendar days, never instants.
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
    periodStart: `${year}-${mm}-01`,
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
 * Invoice due date (P3.A.4): when the customer has a `billingAnchorDay`,
 * the due date is that day-of-month (clamped 1..28, since not every month
 * has a 29th-31st) within the billing period being invoiced. Otherwise it
 * falls back to the settings `dueDays` policy, `dueDays` after `now`'s WIB
 * calendar day (TIME-1 — see this section's doc comment).
 */
function dueDateFor(
  billingAnchorDay: number | null,
  periodStart: string,
  now: Date,
  fallbackDueDays: number,
): string {
  if (billingAnchorDay == null) {
    // TIME-1: anchor on `now`'s WIB calendar day first, not the raw instant
    // — see this section's doc comment for why (`addDays`/`isoDate` are
    // pure getUTC* calendar arithmetic and only correct given a calendar
    // anchor, not an arbitrary instant).
    return isoDate(addDays(wibDateAnchor(now), fallbackDueDays));
  }
  const day = Math.min(28, Math.max(1, billingAnchorDay));
  const [year, month] = periodStart.split('-'); // 'YYYY-MM-01' -> ['YYYY', 'MM', '01']
  return `${year}-${month}-${String(day).padStart(2, '0')}`;
}

/** Invoice total: amount + lateFee + taxAmount - discountAmount (P3.A.4). */
function invoiceTotal(invoice: Invoice): number {
  return invoice.amount + invoice.lateFee + invoice.taxAmount - invoice.discountAmount;
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
    paidAt: row.paidAt.toISOString(),
  };
}
