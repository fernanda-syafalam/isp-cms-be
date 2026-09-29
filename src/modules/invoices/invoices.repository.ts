import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { type Db, DrizzleService } from '../../infrastructure/database/drizzle.service';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import {
  type Invoice,
  type NewInvoice,
  type NewPayment,
  type Payment,
  invoices,
  payments,
} from '../../infrastructure/database/schema/invoices.schema';
import { SlaCreditsRepository } from '../sla-credits/sla-credits.repository';
import type { InvoiceListResponse, InvoiceSummary } from './dto/invoice-response.dto';
import type { PaymentReconciliation } from './dto/payment-reconciliation.dto';
import { invoiceTotal } from './invoice-total';

// Drizzle transaction handle, typed without `any` (mirrors VouchersRepository).
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

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

// Sortable payment columns (camelCase key → column); the whitelist is the security boundary.
const PAYMENT_SORT_WHITELIST = {
  paidAt: payments.paidAt,
  invoiceNo: payments.invoiceNo,
  amount: payments.amount,
  customerName: payments.customerName,
} satisfies Record<string, (typeof payments)[keyof typeof payments]>;

// Statuses that still owe money (outstanding/aging); 'partial' stays unpaid until 'paid'.
const UNPAID_STATUSES = ['pending', 'partial', 'overdue'] as const;

/** Single SQL definition of the invoice total; keep in sync with `invoiceTotal` (TS). */
const invoiceTotalSql = sql`(${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount} - ${invoices.discountAmount})`;

/** Single SQL definition of the balance still owed on an invoice (total minus paid). */
const invoiceBalanceDueSql = sql`(${invoiceTotalSql} - ${invoices.paidAmount})`;

// Eligible to flip to 'overdue' and for the due-soon dunning cohort; excludes 'overdue' itself.
const NOT_YET_OVERDUE_STATUSES = ['pending', 'partial'] as const;

/** Balance due across a customer's unpaid invoices; shared by the plain and in-transaction callers. */
async function sumUnpaid(executor: Db | DbTx, customerId: string): Promise<number> {
  const [row] = await executor
    .select({ total: sql<string>`coalesce(sum(${invoiceBalanceDueSql}), 0)` })
    .from(invoices)
    .where(
      and(eq(invoices.customerId, customerId), inArray(invoices.status, [...UNPAID_STATUSES])),
    );
  return Number(row?.total ?? 0);
}

/**
 * Sole gate to `invoices`/`payments`; returns domain rows, never Drizzle tuples (Pilar 3).
 */
@Injectable()
export class InvoicesRepository {
  constructor(
    private readonly drizzle: DrizzleService,
    // createBilled delegates the SLA-credit 'applied' write to SlaCreditsRepository (one owner of that SET shape).
    private readonly slaCredits: SlaCreditsRepository,
  ) {}

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

    // Full-set summary over ALL invoices (ignores status/q/paging).
    const [summaryRow] = await this.db
      .select({
        total: count(),
        unpaidCount: sql<number>`count(*) filter (where ${inArray(invoices.status, [...UNPAID_STATUSES])})`,
        outstanding: sql<string>`coalesce(sum(case when ${inArray(invoices.status, [...UNPAID_STATUSES])} then ${invoiceBalanceDueSql} else 0 end), 0)`,
        overdue: sql<string>`coalesce(sum(case when ${invoices.status} = 'overdue' then ${invoiceBalanceDueSql} else 0 end), 0)`,
        // Per-status counts (ADR-0011 parity) in one grouped aggregate instead of 5 COUNT queries.
        paidStatus: sql<number>`count(*) filter (where ${invoices.status} = 'paid')`,
        partialStatus: sql<number>`count(*) filter (where ${invoices.status} = 'partial')`,
        pendingStatus: sql<number>`count(*) filter (where ${invoices.status} = 'pending')`,
        overdueStatus: sql<number>`count(*) filter (where ${invoices.status} = 'overdue')`,
        draftStatus: sql<number>`count(*) filter (where ${invoices.status} = 'draft')`,
      })
      .from(invoices);

    const summary: InvoiceSummary = {
      total: summaryRow?.total ?? 0,
      unpaidCount: Number(summaryRow?.unpaidCount ?? 0),
      outstanding: Number(summaryRow?.outstanding ?? 0),
      overdue: Number(summaryRow?.overdue ?? 0),
      byStatus: {
        paid: Number(summaryRow?.paidStatus ?? 0),
        partial: Number(summaryRow?.partialStatus ?? 0),
        pending: Number(summaryRow?.pendingStatus ?? 0),
        overdue: Number(summaryRow?.overdueStatus ?? 0),
        draft: Number(summaryRow?.draftStatus ?? 0),
      },
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

  /**
   * Creates a billing-run invoice and, in the SAME transaction (M2, like
   * `recordPayment`), absorbs the given pending SLA credits and refreshes the
   * customer's `outstanding`, so a crash cannot leave overbilling, a stale
   * `outstanding`, or an invoice that `existsForPeriod` then skips on every retry.
   *
   * Credit absorption is delegated to `SlaCreditsRepository.markAppliedWithInvoice`
   * (given this `tx`) so the 'applied' SET shape has one owner. Writing
   * `customers.outstanding` is the money-path exception documented on
   * `recordPayment`. `creditIds` is usually empty, which makes the credit UPDATE a no-op.
   */
  async createBilled(input: NewInvoice, creditIds: string[]): Promise<Invoice> {
    return this.db.transaction(async (tx) => {
      const [invoice] = await tx.insert(invoices).values(input).returning();
      if (!invoice) {
        throw new Error('invoices.insert returned no row');
      }

      await this.slaCredits.markAppliedWithInvoice(creditIds, invoice.id, tx);

      // Same helper as `recordPayment`; its reactivate branch is a no-op here (a new invoice only adds to `outstanding`).
      await this.refreshOutstandingTx(tx, invoice.customerId);
      return invoice;
    });
  }

  // True if the customer already has a REGULAR invoice for this period (backed by the
  // partial unique index `WHERE type = 'regular'`). Must filter on type: a proration
  // 'adjustment' invoice on the 1st shares the regular invoice's periodStart and would
  // make the billing run skip the month (lost revenue).
  async existsForPeriod(customerId: string, periodStart: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.customerId, customerId),
          eq(invoices.periodStart, periodStart),
          eq(invoices.type, 'regular'),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /** All-or-nothing settlement straight to 'paid'; `applyPayment` supersedes it for partial-pay flows. */
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

  /**
   * Records a (partial or full) payment in one atomic UPDATE: the CASE expressions
   * read the pre-update row, so concurrent payments cannot under/over-count. Flips
   * to 'paid' (stamping `paid_at`) once paid_amount reaches the invoice total, else 'partial'.
   */
  async applyPayment(id: string, amount: number): Promise<Invoice> {
    const [row] = await this.db
      .update(invoices)
      .set({
        paidAmount: sql`${invoices.paidAmount} + ${amount}`,
        status: sql`(case
          when ${invoices.paidAmount} + ${amount}
            >= ${invoiceTotalSql}
          then 'paid' else 'partial'
        end)::invoice_status`,
        paidAt: sql`(case
          when ${invoices.paidAmount} + ${amount}
            >= ${invoiceTotalSql}
          then now() else ${invoices.paidAt}
        end)`,
        updatedAt: sql`now()`,
      })
      // Overpay guard lives in the WHERE so concurrent payments cannot both pass a stale
      // balance check; the predicate re-reads the CURRENT row under the row lock.
      .where(
        and(eq(invoices.id, id), sql`${invoices.paidAmount} + ${amount} <= ${invoiceTotalSql}`),
      )
      .returning();
    if (!row) {
      // Balance no longer admits this amount (concurrent payment); conflict so the caller re-reads.
      const current = await this.findById(id);
      if (!current) throw new NotFoundException('invoice not found');
      throw new ConflictException('Saldo tagihan sudah berubah — muat ulang lalu coba lagi');
    }
    return row;
  }

  /**
   * Records a (partial or full) payment atomically (C2, mirrors
   * `VouchersRepository.settle`): the ledger row, the invoice `paid_amount`/status
   * flip and the customer `outstanding` refresh all land together or none do.
   *
   * Inside `tx`:
   *  1. `SELECT ... FOR UPDATE` locks the invoice; a concurrent call on the same id
   *     blocks, then re-reads the moved status/balance.
   *  2. An already-`paid` invoice is a no-op (idempotent; defense in depth against
   *     a race with the service's own short-circuit).
   *  3. `input.amount` is re-validated against the balance due on the LOCKED row,
   *     not the caller's possibly-stale snapshot.
   *  4. Insert the payment row; 5. update `paid_amount`/status/`paid_at`.
   *  6. Refresh `customers.outstanding` from the same expression as
   *     `sumUnpaidByCustomer`, never a hand-computed delta (see
   *     `VouchersRepository.allocateToInvoices`).
   *
   * Writing `customers` here is the sanctioned money-path exception to "one
   * repository per table" (as in `VouchersRepository.settle`). `reactivated`
   * reports whether an isolir customer was flipped back to `aktif`; re-enabling
   * the PPPoE secret and posting the reseller commission stay in the service,
   * outside this transaction.
   */
  async recordPayment(
    invoiceId: string,
    input: {
      amount: number;
      method: Payment['method'];
      tenderedAmount: number | null;
      changeAmount: number | null;
      // Cashier's manual-entry justification (FIN-D); null for gateway-settled payments. Metadata only.
      note: string | null;
    },
    // Runs last inside the transaction so a caller's own write commits or
    // rolls back together with the payment (e.g. flipping a payment intent).
    withinTx?: (tx: DbTx) => Promise<void>,
  ): Promise<{ invoice: Invoice; reactivated: boolean }> {
    return this.db.transaction(async (tx) => {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .for('update')
        .limit(1);
      if (!invoice) {
        throw new NotFoundException('invoice not found');
      }
      if (invoice.status === 'paid') {
        return { invoice, reactivated: false }; // idempotent — see method doc.
      }

      const total = invoiceTotal(invoice);
      const balanceDue = total - invoice.paidAmount;
      if (input.amount > balanceDue) {
        // Balance moved since the caller's snapshot; conflict so it re-reads.
        throw new ConflictException('Saldo tagihan sudah berubah — muat ulang lalu coba lagi');
      }

      await tx.insert(payments).values({
        invoiceId: invoice.id,
        invoiceNo: invoice.invoiceNo,
        customerId: invoice.customerId,
        customerName: invoice.customerName,
        amount: input.amount,
        method: input.method,
        tenderedAmount: input.tenderedAmount,
        changeAmount: input.changeAmount,
        note: input.note,
      });

      const paidAmount = invoice.paidAmount + input.amount;
      const paidInFull = paidAmount >= total;
      const [updated] = await tx
        .update(invoices)
        .set({
          paidAmount,
          status: paidInFull ? 'paid' : 'partial',
          paidAt: paidInFull ? sql`now()` : invoice.paidAt,
          updatedAt: sql`now()`,
        })
        .where(eq(invoices.id, invoiceId))
        .returning();
      if (!updated) {
        throw new NotFoundException('invoice not found');
      }

      const reactivated = await this.refreshOutstandingTx(tx, invoice.customerId);
      await withinTx?.(tx);
      return { invoice: updated, reactivated };
    });
  }

  /**
   * Recomputes and persists `customers.outstanding` inside the caller's transaction
   * (shared by `recordPayment` and `createBilled`), using `sumUnpaidByCustomer`'s
   * expression. Reactivates an isolir customer whose balance reaches exactly zero
   * (gated on balance, not on "no overdue invoices"); a no-op in `createBilled`,
   * which only adds to the balance.
   */
  private async refreshOutstandingTx(tx: DbTx, customerId: string): Promise<boolean> {
    const outstanding = await sumUnpaid(tx, customerId);

    const [customerRow] = await tx
      .select({ status: customers.status })
      .from(customers)
      .where(eq(customers.id, customerId))
      .for('update')
      .limit(1);
    const reactivate = customerRow?.status === 'isolir' && outstanding === 0;

    await tx
      .update(customers)
      .set({
        outstanding,
        ...(reactivate ? { status: 'aktif' as const } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(customers.id, customerId));

    return reactivate;
  }

  /**
   * Balance due across unpaid invoices; a 'partial' invoice contributes only its remainder.
   */
  async sumUnpaidByCustomer(customerId: string): Promise<number> {
    return sumUnpaid(this.db, customerId);
  }

  // Batched sumUnpaidByCustomer for the billing cron (R6-DB-2). Customers with no
  // unpaid invoices are absent from the map — treat a missing key as 0. Empty input
  // returns an empty Map without querying.
  async sumUnpaidByCustomers(customerIds: string[]): Promise<Map<string, number>> {
    if (customerIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        customerId: invoices.customerId,
        total: sql<string>`coalesce(sum(${invoiceBalanceDueSql}), 0)`,
      })
      .from(invoices)
      .where(
        and(
          inArray(invoices.customerId, customerIds),
          inArray(invoices.status, [...UNPAID_STATUSES]),
        ),
      )
      .groupBy(invoices.customerId);
    return new Map(rows.map((row) => [row.customerId, Number(row.total)]));
  }

  // Batched existsForPeriod (same type='regular' filter) for schedulerPreview (R6-DB-5).
  // Empty input returns an empty Set without querying.
  async existingRegularForPeriod(customerIds: string[], periodStart: string): Promise<Set<string>> {
    if (customerIds.length === 0) return new Set();
    const rows = await this.db
      .selectDistinct({ customerId: invoices.customerId })
      .from(invoices)
      .where(
        and(
          inArray(invoices.customerId, customerIds),
          eq(invoices.periodStart, periodStart),
          eq(invoices.type, 'regular'),
        ),
      );
    return new Set(rows.map((row) => row.customerId));
  }

  async countOverdueByCustomer(customerId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(invoices)
      .where(and(eq(invoices.customerId, customerId), eq(invoices.status, 'overdue')));
    return row?.value ?? 0;
  }

  // --- Billing automation ---------------------------------------------
  // TIME-1: `current_date`/`now()` here run in the DB session timezone (Asia/Jakarta); see `customerIdsIsolirEligible`.

  /** Flips pending/partial invoices past due to overdue and applies the late fee; `paid_amount` is untouched. */
  async markOverduePastDue(lateFee: number): Promise<number> {
    const result = await this.db
      .update(invoices)
      .set({ status: 'overdue', lateFee, updatedAt: sql`now()` })
      .where(
        and(
          inArray(invoices.status, [...NOT_YET_OVERDUE_STATUSES]),
          sql`${invoices.dueDate} < current_date`,
        ),
      );
    return result.rowCount ?? 0;
  }

  async countOverdueAll(): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(invoices)
      .where(eq(invoices.status, 'overdue'));
    return row?.value ?? 0;
  }

  /** Pending/partial invoices due within `days` (upcoming dunning candidates). */
  async countPendingDueSoon(days: number): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(invoices)
      .where(
        and(
          inArray(invoices.status, [...NOT_YET_OVERDUE_STATUSES]),
          // Cast the bound param: `date + unknown` is ambiguous in Postgres ("operator is not unique").
          sql`${invoices.dueDate} <= current_date + ${days}::int`,
        ),
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
        and(
          inArray(invoices.status, [...NOT_YET_OVERDUE_STATUSES]),
          // Cast: see countPendingDueSoon.
          sql`${invoices.dueDate} <= current_date + ${days}::int`,
        ),
      );
    return result.rowCount ?? 0;
  }

  async markRemindedByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.db
      .update(invoices)
      .set({ lastRemindedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(inArray(invoices.id, ids), inArray(invoices.status, [...UNPAID_STATUSES])));
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

  /**
   * Distinct customers with an overdue invoice past due by MORE than `graceDays`
   * (D2): dueDate + graceDays < today. Any overdue row suffices — whenever a later
   * invoice clears the bar the oldest does too. Only isolir selection respects
   * grace; dunning still fires as soon as an invoice is overdue.
   * TIME-1: `current_date` uses the Postgres SESSION timezone (pinned to
   * Asia/Jakarta in `DrizzleService`); the container `TZ` env does not affect a
   * remote server.
   */
  async customerIdsIsolirEligible(graceDays: number): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ customerId: invoices.customerId })
      .from(invoices)
      .where(
        and(
          eq(invoices.status, 'overdue'),
          // Cast: see countPendingDueSoon.
          sql`${invoices.dueDate} + ${graceDays}::int < current_date`,
        ),
      );
    return rows.map((r) => r.customerId);
  }

  /** Distinct customers with a pending/partial invoice due within `days` (dunning H-N). */
  async customerIdsWithPendingDueSoon(days: number): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ customerId: invoices.customerId })
      .from(invoices)
      .where(
        and(
          inArray(invoices.status, [...NOT_YET_OVERDUE_STATUSES]),
          // Cast: see countPendingDueSoon.
          sql`${invoices.dueDate} <= current_date + ${days}::int`,
        ),
      );
    return rows.map((r) => r.customerId);
  }

  // Paid invoices settled in a YYYY-MM period (cash-basis), by settlement time.
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

  /** Unpaid invoices, oldest due date first; feeds the analytics receivables/aging rollup. */
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

  /**
   * Cash-drawer closing report for one UTC day (P3.A.4). A method with no
   * payments is absent from `byMethod`.
   */
  async reconciliation(date: string): Promise<PaymentReconciliation> {
    const rows = await this.db
      .select({
        method: payments.method,
        count: count(),
        totalAmount: sql<string>`coalesce(sum(${payments.amount}), 0)`,
        totalTendered: sql<string>`coalesce(sum(${payments.tenderedAmount}), 0)`,
        totalChange: sql<string>`coalesce(sum(${payments.changeAmount}), 0)`,
      })
      .from(payments)
      .where(sql`to_char(${payments.paidAt} at time zone 'UTC', 'YYYY-MM-DD') = ${date}`)
      .groupBy(payments.method);

    const byMethod = rows.map((row) => ({
      method: row.method,
      count: row.count,
      totalAmount: Number(row.totalAmount),
    }));
    const cashRow = rows.find((row) => row.method === 'cash');

    return {
      date,
      byMethod,
      totalCount: byMethod.reduce((sum, row) => sum + row.count, 0),
      totalAmount: byMethod.reduce((sum, row) => sum + row.totalAmount, 0),
      cash: {
        totalTendered: cashRow ? Number(cashRow.totalTendered) : 0,
        totalChange: cashRow ? Number(cashRow.totalChange) : 0,
      },
    };
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
