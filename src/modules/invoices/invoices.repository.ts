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
import type { InvoiceListResponse, InvoiceSummary } from './dto/invoice-response.dto';
import type { PaymentReconciliation } from './dto/payment-reconciliation.dto';

// The transaction handle drizzle hands its callback — used to type the
// private write helper without an `any` (mirrors VouchersRepository).
type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

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

// Statuses that still owe money — used for the outstanding/aging total.
// 'partial' (P3.A.4) is unpaid too: a part-paid invoice still counts as
// outstanding and still gets dunned until it reaches 'paid'.
const UNPAID_STATUSES = ['pending', 'partial', 'overdue'] as const;

// Statuses eligible to flip to 'overdue' once past due date, and eligible
// for the "due soon" (not-yet-overdue) dunning cohort. Excludes 'overdue'
// itself — those invoices already went through the transition.
const NOT_YET_OVERDUE_STATUSES = ['pending', 'partial'] as const;

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
    // balance due per invoice = amount + late_fee + tax_amount - discount_amount
    // - paid_amount (P3.A.4) — a 'partial' invoice only contributes what's
    // actually still owed, never its full gross total (no double-count with
    // what was already paid or discounted via an SLA credit).
    const [summaryRow] = await this.db
      .select({
        total: count(),
        unpaidCount: sql<number>`count(*) filter (where ${invoices.status} in ('pending', 'partial', 'overdue'))`,
        outstanding: sql<string>`coalesce(sum(case when ${invoices.status} in ('pending', 'partial', 'overdue') then ${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount} - ${invoices.discountAmount} - ${invoices.paidAmount} else 0 end), 0)`,
        overdue: sql<string>`coalesce(sum(case when ${invoices.status} = 'overdue' then ${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount} - ${invoices.discountAmount} - ${invoices.paidAmount} else 0 end), 0)`,
        // Per-status counts (FE status filter tabs, ADR-0011 parity) — a
        // single grouped-filter aggregate avoids 5 separate COUNT queries.
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

  /**
   * All-or-nothing settlement: flips straight to 'paid' regardless of what
   * was already paid. Superseded by `applyPayment` for the loket/partial-pay
   * flow (P3.A.4) — kept for callers that only ever settle in full.
   */
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
   * Record a (partial or full) payment against an invoice: increments
   * `paid_amount` by `amount` and derives the new status from a single
   * atomic UPDATE — the CASE expressions read the pre-update row (standard
   * Postgres SET semantics), so a concurrent payment can never under- or
   * over-count. Flips to 'paid' (and stamps `paid_at`) only once the new
   * paid_amount reaches the invoice total (amount + late_fee + tax_amount -
   * discount_amount); otherwise the invoice is 'partial'.
   */
  async applyPayment(id: string, amount: number): Promise<Invoice> {
    const [row] = await this.db
      .update(invoices)
      .set({
        paidAmount: sql`${invoices.paidAmount} + ${amount}`,
        status: sql`(case
          when ${invoices.paidAmount} + ${amount}
            >= ${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount} - ${invoices.discountAmount}
          then 'paid' else 'partial'
        end)::invoice_status`,
        paidAt: sql`(case
          when ${invoices.paidAmount} + ${amount}
            >= ${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount} - ${invoices.discountAmount}
          then now() else ${invoices.paidAt}
        end)`,
        updatedAt: sql`now()`,
      })
      // Overpay guard lives in the WHERE (not just the service snapshot) so two
      // concurrent payments cannot both pass a stale balance check and overshoot
      // paid_amount. The predicate re-reads the CURRENT row under the row lock.
      .where(
        and(
          eq(invoices.id, id),
          sql`${invoices.paidAmount} + ${amount} <= ${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount} - ${invoices.discountAmount}`,
        ),
      )
      .returning();
    if (!row) {
      // The invoice exists (service checked) but the balance no longer admits
      // this amount — a concurrent payment moved it. Surface as a conflict so
      // the caller re-reads rather than silently over-crediting.
      const current = await this.findById(id);
      if (!current) throw new NotFoundException('invoice not found');
      throw new ConflictException('Saldo tagihan sudah berubah — muat ulang lalu coba lagi');
    }
    return row;
  }

  /**
   * Record a (partial or full) payment against an invoice, atomically (C2,
   * mirrors `VouchersRepository.settle` / `ResellersRepository.disbursePayout`):
   * the ledger row, the invoice's `paid_amount`/status flip, and the paying
   * customer's `outstanding` refresh either all land together or none do.
   * Previously these were three separate round-trips through `applyPayment` +
   * `createPayment` + a later `sumUnpaidByCustomer`/`setBilling` call — a
   * crash after the status flip committed left a `paid` invoice with no
   * payments row: money invisible to cash-drawer reconciliation and never
   * retried.
   *
   * Steps, all inside `tx`:
   *  1. `SELECT ... FOR UPDATE` locks the invoice row — a concurrent second
   *     call on the same id blocks until this transaction commits, then
   *     re-reads a status/balance that has since moved.
   *  2. Idempotency: an already-`paid` invoice is a no-op — no new payment
   *     row, no re-application (mirrors `settle()`'s used-voucher guard; the
   *     service already short-circuits on this too, so this is defense in
   *     depth against a race between the service's read and this lock).
   *  3. Re-validates `input.amount` against the balance due on the LOCKED
   *     row (not the caller's possibly-stale snapshot) — throws the same
   *     `ConflictException` the old `applyPayment` WHERE guard threw on a
   *     genuine race.
   *  4. Inserts the payment ledger row.
   *  5. Updates `paid_amount`/status/`paid_at` on the invoice.
   *  6. Recomputes and persists `customers.outstanding` from the exact same
   *     expression `sumUnpaidByCustomer` uses — never a hand-computed delta
   *     (see `VouchersRepository.allocateToInvoices` for why that matters).
   *
   * This is the same deliberate "one repository per table" exception
   * `VouchersRepository.settle` documents: it reaches into `customers`
   * directly so the outstanding refresh shares this transaction. Whether the
   * payment cleared an isolir customer's debt is signaled back via
   * `reactivated` — flipping `customers.status` back to `aktif` is done here
   * (same table, same transaction), but re-enabling the PPPoE secret (a
   * different module's repository) and posting the reseller commission stay
   * in the service, outside this transaction, unchanged from before.
   */
  async recordPayment(
    invoiceId: string,
    input: {
      amount: number;
      method: Payment['method'];
      tenderedAmount: number | null;
      changeAmount: number | null;
    },
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

      const total = invoice.amount + invoice.lateFee + invoice.taxAmount - invoice.discountAmount;
      const balanceDue = total - invoice.paidAmount;
      if (input.amount > balanceDue) {
        // The balance moved under us since the caller's snapshot — surface as
        // a conflict so it re-reads rather than silently over-crediting.
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
      return { invoice: updated, reactivated };
    });
  }

  /**
   * Recompute `customers.outstanding` from `sumUnpaidByCustomer`'s exact
   * expression and persist it, inside the caller's transaction — shared by
   * `recordPayment` (C2) and available to any other write that must keep
   * `outstanding` in sync within the same transaction (C3 refreshes it
   * outside a transaction via the public `sumUnpaidByCustomer` + the
   * customers repository instead, since invoice-create has no invoice-row
   * lock to hold open). Reactivates an isolir customer whose balance just
   * reached zero — mirrors `InvoicesService.refreshCustomerBilling`'s old
   * gate (strictly on the balance, never on "no more overdue invoices").
   */
  private async refreshOutstandingTx(tx: DbTx, customerId: string): Promise<boolean> {
    const [sumRow] = await tx
      .select({
        total: sql<string>`coalesce(sum(${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount} - ${invoices.discountAmount} - ${invoices.paidAmount}), 0)`,
      })
      .from(invoices)
      .where(
        and(eq(invoices.customerId, customerId), inArray(invoices.status, [...UNPAID_STATUSES])),
      );
    const outstanding = Number(sumRow?.total ?? 0);

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
   * Sum of what's still owed across every unpaid invoice: balance due =
   * amount + lateFee + taxAmount - discountAmount - paidAmount (P3.A.4). A
   * 'partial' invoice only contributes its remaining slice, never its full
   * gross total, so this never double-counts a payment already recorded or
   * an SLA credit already applied as a discount line.
   */
  async sumUnpaidByCustomer(customerId: string): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount} - ${invoices.discountAmount} - ${invoices.paidAmount}), 0)`,
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

  /**
   * Flip pending/partial invoices past their due date to overdue + apply
   * the late fee. A 'partial' invoice past due is still unpaid, so it
   * transitions too (paid_amount is untouched — only status/lateFee change).
   */
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
          // Cast the bound param: `date + unknown` is ambiguous in Postgres, so
          // an untyped $n fails with "operator is not unique". `date + int` adds days.
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
          // Cast the bound param: `date + unknown` is ambiguous in Postgres, so
          // an untyped $n fails with "operator is not unique". `date + int` adds days.
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

  /** Distinct customers with a pending/partial invoice due within `days` (dunning H-N). */
  async customerIdsWithPendingDueSoon(days: number): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ customerId: invoices.customerId })
      .from(invoices)
      .where(
        and(
          inArray(invoices.status, [...NOT_YET_OVERDUE_STATUSES]),
          // Cast the bound param: `date + unknown` is ambiguous in Postgres, so
          // an untyped $n fails with "operator is not unique". `date + int` adds days.
          sql`${invoices.dueDate} <= current_date + ${days}::int`,
        ),
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

  /**
   * The loket/cash-drawer closing report for one calendar day (UTC,
   * P3.A.4): per-method count + amount totals, plus the cash-only
   * tendered/change roll-up. A method with no payments that day is simply
   * absent from `byMethod` (never a zero row).
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
