import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Invoice, Payment } from '../../infrastructure/database/schema/invoices.schema';
import { CustomersRepository } from '../customers/customers.repository';
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

    const updated = await this.repo.applyPayment(id, amount);
    await this.repo.createPayment({
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      amount,
      method: input.method,
      tenderedAmount,
      changeAmount,
    });
    await this.refreshCustomerBilling(invoice.customerId);
    // Reactivation + commission are keyed off the invoice actually reaching
    // 'paid' — a partial payment must never trigger either.
    if (updated.status === 'paid') {
      await this.postResellerCommission(invoice.customerId, invoice.id, total);
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
    for (const customer of billables) {
      if (await this.repo.existsForPeriod(customer.id, periodStart)) continue;
      const amount = customer.planPriceMonthly;
      const taxAmount = policy.pkp ? ppnOf(amount, policy.ppnRate) : 0;
      const { discountAmount, creditIds } = await this.resolveSlaDiscount(
        customer.id,
        amount + taxAmount,
      );
      const invoice = await this.repo.create({
        customerId: customer.id,
        customerName: customer.fullName,
        periodStart,
        periodEnd,
        dueDate: dueDateFor(customer.billingAnchorDay, periodStart, now, policy.dueDays),
        amount,
        taxAmount,
        discountAmount,
        status: 'pending',
      });
      await this.absorbSlaCredits(creditIds, invoice.id);
      created += 1;
    }

    this.logger.log({ period: periodLabel, created }, 'billing run');
    return { period: periodLabel, created };
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
    const invoice = await this.repo.create({
      customerId,
      customerName: info.fullName,
      periodStart,
      periodEnd,
      dueDate: dueDateFor(info.billingAnchorDay, periodStart, now, policy.dueDays),
      amount,
      taxAmount,
      discountAmount,
      status: 'pending',
    });
    await this.absorbSlaCredits(creditIds, invoice.id);
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

  private async absorbSlaCredits(creditIds: string[], invoiceId: string): Promise<void> {
    if (creditIds.length === 0) return;
    await this.slaCredits.markAppliedWithInvoice(creditIds, invoiceId);
  }

  private async refreshCustomerBilling(customerId: string): Promise<void> {
    const outstanding = await this.repo.sumUnpaidByCustomer(customerId);
    const customer = await this.customers.findById(customerId);
    // Gate strictly on the actual balance, not "no more overdue invoices":
    // a 'partial' invoice has no 'overdue' status but can still leave a
    // balance > 0, and must never trigger reactivation (P3.A.4).
    const reactivate = customer?.status === 'isolir' && outstanding === 0;
    await this.customers.setBilling(customerId, {
      outstanding,
      ...(reactivate ? { status: 'aktif' as const } : {}),
    });
    // Payment cleared the debt -> bring the PPPoE secret back online (ADR-0008).
    if (reactivate) {
      await this.secrets.setDisabledByCustomerId(customerId, false);
    }
  }
}

function ppnOf(amount: number, rate: number): number {
  return Math.round(amount * rate);
}

// --- date helpers (whole-day, UTC) ------------------------------------

function currentPeriod(now: Date): {
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
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
 * falls back to the settings `dueDays` policy, `dueDays` after `now`.
 */
function dueDateFor(
  billingAnchorDay: number | null,
  periodStart: string,
  now: Date,
  fallbackDueDays: number,
): string {
  if (billingAnchorDay == null) {
    return isoDate(addDays(now, fallbackDueDays));
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
