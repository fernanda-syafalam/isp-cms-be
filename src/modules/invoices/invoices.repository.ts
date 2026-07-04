import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type Invoice,
  type NewInvoice,
  type NewPayment,
  type Payment,
  invoices,
  payments,
} from '../../infrastructure/database/schema/invoices.schema';
import type { InvoiceListResponse, InvoiceSummary } from './dto/invoice-response.dto';

export interface InvoiceListFilter {
  status?: Invoice['status'];
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface PaymentListFilter {
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

// Columns the frontend is allowed to sort invoices on (camelCase key → Drizzle column).
// Unknown/absent key falls back to `dueDate desc` via buildOrderBy — never throws.
const INVOICE_SORT_WHITELIST = {
  invoiceNo: invoices.invoiceNo,
  customerName: invoices.customerName,
  amount: invoices.amount,
  dueDate: invoices.dueDate,
  status: invoices.status,
  lastRemindedAt: invoices.lastRemindedAt,
} satisfies Record<string, (typeof invoices)[keyof typeof invoices]>;

// Columns the frontend is allowed to sort payments on (camelCase key → Drizzle column).
// Extend this map as new sortable columns are added; never pass arbitrary
// column references — the whitelist is the security boundary.
const PAYMENT_SORT_WHITELIST = {
  paidAt: payments.paidAt,
  invoiceNo: payments.invoiceNo,
  amount: payments.amount,
  customerName: payments.customerName,
} satisfies Record<string, (typeof payments)[keyof typeof payments]>;

// Statuses that still owe money — used for the outstanding total.
const UNPAID_STATUSES = ['pending', 'overdue'] as const;

/**
 * The only place that talks to the `invoices` and `payments` tables.
 * Returns domain rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class InvoicesRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async list(
    filter: InvoiceListFilter,
  ): Promise<Omit<InvoiceListResponse, 'items'> & { items: Invoice[] }> {
    // WHERE clause for status + q (applied to items + filtered total).
    const where = and(
      filter.status ? eq(invoices.status, filter.status) : undefined,
      filter.q
        ? or(
            ilike(invoices.invoiceNo, `%${filter.q}%`),
            ilike(invoices.customerName, `%${filter.q}%`),
          )
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      INVOICE_SORT_WHITELIST,
      desc(invoices.dueDate),
    );

    const items = await this.db
      .select()
      .from(invoices)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);

    const [filteredCount] = await this.db.select({ value: count() }).from(invoices).where(where);

    // Full-set summary — computed over ALL invoices, ignoring status/q/paging.
    // grand total per invoice = amount + late_fee + tax_amount.
    const [summaryRow] = await this.db
      .select({
        total: count(),
        unpaidCount: sql<number>`count(*) filter (where ${invoices.status} in ('pending', 'overdue'))`,
        outstanding: sql<string>`coalesce(sum(case when ${invoices.status} in ('pending', 'overdue') then ${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount} else 0 end), 0)`,
        overdue: sql<string>`coalesce(sum(case when ${invoices.status} = 'overdue' then ${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount} else 0 end), 0)`,
      })
      .from(invoices);

    const summary: InvoiceSummary = {
      total: summaryRow?.total ?? 0,
      unpaidCount: Number(summaryRow?.unpaidCount ?? 0),
      outstanding: Number(summaryRow?.outstanding ?? 0),
      overdue: Number(summaryRow?.overdue ?? 0),
    };

    return { items, total: filteredCount?.value ?? 0, summary };
  }

  async findById(id: string): Promise<Invoice | null> {
    const [row] = await this.db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    return row ?? null;
  }

  // A single customer's invoices, newest first — the portal "me" snapshot.
  async listByCustomer(customerId: string): Promise<Invoice[]> {
    return this.db
      .select()
      .from(invoices)
      .where(eq(invoices.customerId, customerId))
      .orderBy(desc(invoices.createdAt));
  }

  async create(input: NewInvoice): Promise<Invoice> {
    const [row] = await this.db.insert(invoices).values(input).returning();
    if (!row) {
      throw new Error('invoices.insert returned no row');
    }
    return row;
  }

  // True if the customer already has an invoice for this period — the
  // unique index guarantees it, this lets a billing run skip cleanly.
  async existsForPeriod(customerId: string, periodStart: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.customerId, customerId), eq(invoices.periodStart, periodStart)))
      .limit(1);
    return Boolean(row);
  }

  async markPaid(id: string): Promise<Invoice> {
    const [row] = await this.db
      .update(invoices)
      .set({ status: 'paid', paidAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(invoices.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('invoice not found');
    }
    return row;
  }

  /** Sum of unpaid invoice totals (amount + lateFee + taxAmount). */
  async sumUnpaidByCustomer(customerId: string): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount}), 0)`,
      })
      .from(invoices)
      .where(
        and(eq(invoices.customerId, customerId), inArray(invoices.status, [...UNPAID_STATUSES])),
      );
    return Number(row?.total ?? 0);
  }

  async countOverdueByCustomer(customerId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(invoices)
      .where(and(eq(invoices.customerId, customerId), eq(invoices.status, 'overdue')));
    return row?.value ?? 0;
  }

  // --- Billing automation ---------------------------------------------

  /** Flip pending invoices past their due date to overdue + apply the late fee. */
  async markOverduePastDue(lateFee: number): Promise<number> {
    const result = await this.db
      .update(invoices)
      .set({ status: 'overdue', lateFee, updatedAt: sql`now()` })
      .where(and(eq(invoices.status, 'pending'), sql`${invoices.dueDate} < current_date`));
    return result.rowCount ?? 0;
  }

  async countOverdueAll(): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(invoices)
      .where(eq(invoices.status, 'overdue'));
    return row?.value ?? 0;
  }

  /** Pending invoices due within `days` (upcoming dunning candidates). */
  async countPendingDueSoon(days: number): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(invoices)
      .where(
        and(eq(invoices.status, 'pending'), sql`${invoices.dueDate} <= current_date + ${days}`),
      );
    return row?.value ?? 0;
  }

  async markRemindedOverdue(): Promise<number> {
    const result = await this.db
      .update(invoices)
      .set({ lastRemindedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(invoices.status, 'overdue'));
    return result.rowCount ?? 0;
  }

  async markRemindedDueSoon(days: number): Promise<number> {
    const result = await this.db
      .update(invoices)
      .set({ lastRemindedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(eq(invoices.status, 'pending'), sql`${invoices.dueDate} <= current_date + ${days}`),
      );
    return result.rowCount ?? 0;
  }

  async markRemindedByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.db
      .update(invoices)
      .set({ lastRemindedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(inArray(invoices.id, ids), inArray(invoices.status, ['pending', 'overdue'])));
    return result.rowCount ?? 0;
  }

  /** Distinct customers that currently have an overdue invoice. */
  async customerIdsWithOverdue(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ customerId: invoices.customerId })
      .from(invoices)
      .where(eq(invoices.status, 'overdue'));
    return rows.map((r) => r.customerId);
  }

  /** Distinct customers with a pending invoice due within `days` (dunning H-N). */
  async customerIdsWithPendingDueSoon(days: number): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ customerId: invoices.customerId })
      .from(invoices)
      .where(
        and(eq(invoices.status, 'pending'), sql`${invoices.dueDate} <= current_date + ${days}`),
      );
    return rows.map((r) => r.customerId);
  }

  // Paid invoices settled within a YYYY-MM period (cash-basis) — the source
  // of the accounting journal. Ordered by settlement time.
  async findPaidInPeriod(period: string): Promise<Invoice[]> {
    return this.db
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.status, 'paid'), sql`to_char(${invoices.paidAt}, 'YYYY-MM') = ${period}`),
      )
      .orderBy(asc(invoices.paidAt));
  }

  // --- Analytics support ----------------------------------------------

  /**
   * Every unpaid invoice (pending + overdue), oldest due date first. The
   * analytics rollup derives total receivables, the overdue slice, and the
   * aging buckets from this single read.
   */
  async listUnpaid(): Promise<Invoice[]> {
    return this.db
      .select()
      .from(invoices)
      .where(inArray(invoices.status, [...UNPAID_STATUSES]))
      .orderBy(asc(invoices.dueDate));
  }

  /** Settled cash per calendar month (UTC, YYYY-MM) since `since`, from payments. */
  async revenueByMonth(since: Date): Promise<Array<{ month: string; revenue: number }>> {
    const rows = await this.db
      .select({
        month: sql<string>`to_char(${payments.paidAt} at time zone 'UTC', 'YYYY-MM')`,
        revenue: sql<string>`coalesce(sum(${payments.amount}), 0)`,
      })
      .from(payments)
      .where(gte(payments.paidAt, since))
      .groupBy(sql`to_char(${payments.paidAt} at time zone 'UTC', 'YYYY-MM')`);
    return rows.map((row) => ({ month: row.month, revenue: Number(row.revenue) }));
  }

  // --- Payments ledger ------------------------------------------------

  async listPayments(filter: PaymentListFilter): Promise<{ items: Payment[]; total: number }> {
    const where = filter.q
      ? or(
          ilike(payments.invoiceNo, `%${filter.q}%`),
          ilike(payments.customerName, `%${filter.q}%`),
        )
      : undefined;

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      PAYMENT_SORT_WHITELIST,
      desc(payments.paidAt),
    );

    const items = await this.db
      .select()
      .from(payments)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(payments).where(where);
    return { items, total: totals?.value ?? 0 };
  }

  // A single customer's recorded payments, newest first (portal snapshot).
  async listPaymentsByCustomer(customerId: string): Promise<Payment[]> {
    return this.db
      .select()
      .from(payments)
      .where(eq(payments.customerId, customerId))
      .orderBy(desc(payments.paidAt));
  }

  async createPayment(input: NewPayment): Promise<Payment> {
    const [row] = await this.db.insert(payments).values(input).returning();
    if (!row) {
      throw new Error('payments.insert returned no row');
    }
    return row;
  }
}
