import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Invoice, Payment } from '../../infrastructure/database/schema/invoices.schema';
import { CustomersRepository } from '../customers/customers.repository';
import { SecretsRepository } from '../router-resources/secrets.repository';
import type { BillingRunResult } from './dto/billing-run-result.dto';
import type { InvoiceListResponse, InvoiceResponse } from './dto/invoice-response.dto';
import type { PaymentResponse } from './dto/payment-response.dto';
import type { RecordPaymentInput } from './dto/record-payment.dto';
import {
  type InvoiceListFilter,
  InvoicesRepository,
  type PaymentListFilter,
} from './invoices.repository';

// Billing policy constants. These belong in a settings module once it
// exists; until then they are the documented defaults.
const PKP = true; // issuer is a taxable enterprise -> charge PPN
const TAX_RATE = 0.11; // PPN 11%
const DUE_DAYS = 10; // invoice is due this many days after issue

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

  /**
   * Settle an invoice: mark it paid, write a ledger entry, then refresh
   * the customer's outstanding balance and reactivate them from isolir if
   * they have no overdue invoices left. Paying an already-paid invoice is
   * a no-op (no duplicate ledger entry).
   */
  async pay(id: string, input: RecordPaymentInput): Promise<InvoiceResponse> {
    const invoice = await this.repo.findById(id);
    if (!invoice) throw new NotFoundException('invoice not found');
    if (invoice.status === 'paid') {
      return toInvoiceResponse(invoice);
    }

    const total = invoice.amount + invoice.lateFee + invoice.taxAmount;
    const paid = await this.repo.markPaid(id);
    await this.repo.createPayment({
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      amount: total,
      method: input.method,
    });
    await this.refreshCustomerBilling(invoice.customerId);
    this.logger.log({ invoiceId: id, method: input.method }, 'invoice paid');
    return toInvoiceResponse(paid);
  }

  /**
   * Generate this month's invoices for every active customer that does
   * not already have one. Idempotent: a re-run creates nothing.
   */
  async run(): Promise<BillingRunResult> {
    const now = new Date();
    const { periodStart, periodEnd, periodLabel } = currentPeriod(now);
    const dueDate = isoDate(addDays(now, DUE_DAYS));

    const billables = await this.customers.findActiveBillable();
    let created = 0;
    for (const customer of billables) {
      if (await this.repo.existsForPeriod(customer.id, periodStart)) continue;
      const amount = customer.planPriceMonthly;
      await this.repo.create({
        customerId: customer.id,
        customerName: customer.fullName,
        periodStart,
        periodEnd,
        dueDate,
        amount,
        taxAmount: PKP ? ppnOf(amount) : 0,
        status: 'pending',
      });
      created += 1;
    }

    this.logger.log({ period: periodLabel, created }, 'billing run');
    return { period: periodLabel, created };
  }

  /**
   * Issue a customer's first invoice at installation time. Idempotent:
   * skips if one already exists for the current period (the work-order
   * `complete` flow may be retried). No-op if the customer is unknown.
   */
  async generateFirstInvoice(customerId: string): Promise<void> {
    const info = await this.customers.findBillingInfo(customerId);
    if (!info) return;

    const now = new Date();
    const { periodStart, periodEnd } = currentPeriod(now);
    if (await this.repo.existsForPeriod(customerId, periodStart)) return;

    const amount = info.planPriceMonthly;
    await this.repo.create({
      customerId,
      customerName: info.fullName,
      periodStart,
      periodEnd,
      dueDate: isoDate(addDays(now, DUE_DAYS)),
      amount,
      taxAmount: PKP ? ppnOf(amount) : 0,
      status: 'pending',
    });
    this.logger.log({ customerId }, 'first invoice generated');
  }

  private async refreshCustomerBilling(customerId: string): Promise<void> {
    const outstanding = await this.repo.sumUnpaidByCustomer(customerId);
    const customer = await this.customers.findById(customerId);
    const reactivate =
      customer?.status === 'isolir' && (await this.repo.countOverdueByCustomer(customerId)) === 0;
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

function ppnOf(amount: number): number {
  return Math.round(amount * TAX_RATE);
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

function toInvoiceResponse(row: Invoice): InvoiceResponse {
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
    paidAt: row.paidAt.toISOString(),
  };
}
