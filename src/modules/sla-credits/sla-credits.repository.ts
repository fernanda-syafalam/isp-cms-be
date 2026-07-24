import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { type Db, DrizzleService } from '../../infrastructure/database/drizzle.service';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { invoices } from '../../infrastructure/database/schema/invoices.schema';
import {
  type NewSlaCredit,
  type SlaCredit,
  slaCredits,
} from '../../infrastructure/database/schema/sla-credits.schema';
import type { SlaCreditSummary } from './dto/sla-credit-response.dto';

// The transaction handle drizzle hands its callback — used to type
// `applyWithInvoiceCredit`'s handle without an `any` (mirrors
// InvoicesRepository / VouchersRepository / CustomersRepository's
// identical local alias).
type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Statuses that still owe money — the exact same tuple
// `InvoicesRepository` uses for `sumUnpaidByCustomer` / `UNPAID_STATUSES`.
// Duplicated locally so this money-critical transaction is self-contained
// and auditable within this one file (same convention as
// `CustomersRepository.applyProration`'s identical copy).
const UNPAID_STATUSES = ['pending', 'partial', 'overdue'] as const;

// Columns the frontend may sort on (camelCase key → Drizzle column).
// Unknown/absent key falls back to `createdAt desc` via buildOrderBy — never throws.
const SLA_CREDITS_SORT_WHITELIST = {
  customerName: slaCredits.customerName,
  amount: slaCredits.amount,
  createdAt: slaCredits.createdAt,
} satisfies Record<string, (typeof slaCredits)[keyof typeof slaCredits]>;

export interface SlaCreditListFilter {
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/**
 * The only place that talks to the `sla_credits` table. Returns domain
 * rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class SlaCreditsRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async list(
    filter: SlaCreditListFilter,
  ): Promise<{ items: SlaCredit[]; total: number; summary: SlaCreditSummary }> {
    // WHERE clause for q (applied to items + filtered total; NOT applied to summary).
    const where = filter.q
      ? or(
          ilike(slaCredits.customerName, `%${filter.q}%`),
          ilike(slaCredits.reason, `%${filter.q}%`),
        )
      : undefined;

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      SLA_CREDITS_SORT_WHITELIST,
      desc(slaCredits.createdAt),
    );

    const items = await this.db
      .select()
      .from(slaCredits)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);

    const [filteredCount] = await this.db.select({ value: count() }).from(slaCredits).where(where);

    // Full-set summary — computed over ALL sla_credits, ignoring q/paging.
    const [summaryRow] = await this.db
      .select({
        total: count(),
        activeAmount: sql<string>`coalesce(sum(case when ${slaCredits.status} != 'void' then ${slaCredits.amount} else 0 end), 0)`,
        pending: sql<number>`count(*) filter (where ${slaCredits.status} = 'pending')`,
        applied: sql<number>`count(*) filter (where ${slaCredits.status} = 'applied')`,
        voidCount: sql<number>`count(*) filter (where ${slaCredits.status} = 'void')`,
      })
      .from(slaCredits);

    const summary: SlaCreditSummary = {
      total: summaryRow?.total ?? 0,
      activeAmount: Number(summaryRow?.activeAmount ?? 0),
      pending: Number(summaryRow?.pending ?? 0),
      applied: Number(summaryRow?.applied ?? 0),
      void: Number(summaryRow?.voidCount ?? 0),
    };

    return { items, total: filteredCount?.value ?? 0, summary };
  }

  async findById(id: string): Promise<SlaCredit | null> {
    const [row] = await this.db.select().from(slaCredits).where(eq(slaCredits.id, id)).limit(1);
    return row ?? null;
  }

  async create(input: NewSlaCredit): Promise<SlaCredit> {
    const [row] = await this.db.insert(slaCredits).values(input).returning();
    if (!row) {
      throw new Error('sla_credits.insert returned no row');
    }
    return row;
  }

  // --- Analytics support ----------------------------------------------

  /** SLA credits awaiting application — the dashboard command-center badge. */
  async countPending(): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(slaCredits)
      .where(eq(slaCredits.status, 'pending'));
    return row?.value ?? 0;
  }

  /**
   * Transition-only apply — used when the credit has no resolved
   * `customerId` (nothing to deduct anywhere). For a credit that DOES
   * resolve to a customer, `SlaCreditsService.apply` calls
   * `applyWithInvoiceCredit` instead, which also deducts a real invoice
   * line — see that method's doc.
   */
  async apply(id: string): Promise<SlaCredit> {
    const [row] = await this.db
      .update(slaCredits)
      .set({ status: 'applied', appliedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(slaCredits.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('sla credit not found');
    }
    return row;
  }

  /**
   * Apply a credit that resolves to a real customer, in ONE transaction:
   * if — and ONLY if — its oldest unpaid invoice can absorb the credit IN
   * FULL right now, deduct it via `discountAmount` and transition to
   * 'applied'. Otherwise LEAVE IT PENDING (see below) — never a
   * hand-computed delta on `customers.outstanding` directly (that was the
   * silent-wipe bug: `outstanding` is a DERIVED column, recomputed from
   * unpaid invoices on every billing event, so a bare delta with no
   * backing invoice row gets silently erased by the next recompute).
   *
   * The deduction targets a SINGLE invoice — the customer's oldest unpaid
   * one by due date — so `appliedInvoiceId` (a single FK) stays
   * unambiguous, mirroring `InvoicesService.resolveSlaDiscount`'s
   * single-invoice absorption at billing time.
   *
   * MED #3 (PR #121 money review — "credit vanishes"): if the customer has
   * NO unpaid invoice, or the credit is LARGER than that invoice's balance
   * due, this does NOT mark the credit 'applied' with nothing (or only
   * part of it) deducted — a partial-now / remainder-later split would
   * double count, because a LATER billing run's absorption
   * (`resolveSlaDiscount`) has no concept of "this credit was already
   * partly spent," and re-marking an 'applied' credit's amount toward a
   * future invoice is not a code path that exists. Instead the credit is
   * left `status: 'pending'`, UNTOUCHED — the exact same pending-absorption
   * mechanism (`findPendingByCustomer` -> `resolveSlaDiscount` ->
   * `InvoicesRepository.createBilled`, M2) a newly-created credit already
   * relies on, so a future billing run picks it up in full. A credit the
   * customer earned is never silently consumed for nothing.
   *
   * `SELECT ... FOR UPDATE` locks this credit row first (idempotency
   * re-check, defense in depth — the service already guards this), then
   * the chosen invoice, then the CUSTOMER row LAST, right before the
   * final outstanding recompute — the exact lock order
   * `InvoicesRepository.recordPayment` / `refreshOutstandingTx` use, so a
   * concurrent payment against the same customer can only ever serialize
   * on the shared locks, never deadlock against this method.
   */
  async applyWithInvoiceCredit(id: string, customerId: string): Promise<SlaCredit> {
    return this.db.transaction(async (tx) => {
      const [credit] = await tx
        .select()
        .from(slaCredits)
        .where(eq(slaCredits.id, id))
        .for('update')
        .limit(1);
      if (!credit) {
        throw new NotFoundException('sla credit not found');
      }
      if (credit.status !== 'pending') {
        return credit; // idempotent no-op — see method doc.
      }

      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(
          and(eq(invoices.customerId, customerId), inArray(invoices.status, [...UNPAID_STATUSES])),
        )
        .orderBy(asc(invoices.dueDate))
        .for('update')
        .limit(1);

      const balanceDue = invoice
        ? invoice.amount +
          invoice.lateFee +
          invoice.taxAmount -
          invoice.discountAmount -
          invoice.paidAmount
        : 0;

      if (!invoice || balanceDue < credit.amount) {
        // Defer — see method doc (MED #3). Left exactly as-is (still
        // 'pending'); nothing on `invoices`/`customers` changes.
        return credit;
      }

      await tx
        .update(invoices)
        .set({
          discountAmount: sql`${invoices.discountAmount} + ${credit.amount}`,
          updatedAt: sql`now()`,
        })
        .where(eq(invoices.id, invoice.id));

      const [applied] = await tx
        .update(slaCredits)
        .set({
          status: 'applied',
          appliedInvoiceId: invoice.id,
          appliedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(slaCredits.id, id))
        .returning();
      if (!applied) {
        throw new NotFoundException('sla credit not found');
      }

      await this.refreshOutstandingTx(tx, customerId);
      return applied;
    });
  }

  /**
   * Recompute `customers.outstanding` from the exact same expression
   * `InvoicesRepository.sumUnpaidByCustomer` uses and persist it, inside
   * the caller's transaction — mirrors
   * `InvoicesRepository.refreshOutstandingTx` /
   * `CustomersRepository.applyProration`'s identical helper. The customer
   * row is locked FOR UPDATE immediately before the recompute (the LAST
   * lock this transaction takes).
   */
  private async refreshOutstandingTx(tx: DbTx, customerId: string): Promise<void> {
    await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, customerId))
      .for('update')
      .limit(1);
    const [sumRow] = await tx
      .select({
        total: sql<string>`coalesce(sum(${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount} - ${invoices.discountAmount} - ${invoices.paidAmount}), 0)`,
      })
      .from(invoices)
      .where(
        and(eq(invoices.customerId, customerId), inArray(invoices.status, [...UNPAID_STATUSES])),
      );
    await tx
      .update(customers)
      .set({ outstanding: Number(sumRow?.total ?? 0), updatedAt: sql`now()` })
      .where(eq(customers.id, customerId));
  }

  /**
   * A customer's pending credits, oldest first — the billing run absorbs
   * these into the next invoice as a discount line (P3.A.4).
   */
  async findPendingByCustomer(customerId: string): Promise<SlaCredit[]> {
    return this.db
      .select()
      .from(slaCredits)
      .where(and(eq(slaCredits.customerId, customerId), eq(slaCredits.status, 'pending')))
      .orderBy(asc(slaCredits.createdAt));
  }

  /**
   * Absorb a batch of pending credits into an invoice's discount line
   * (P3.A.4): transitions them straight to 'applied' and stamps the invoice
   * that absorbed them, in one statement so a billing-run retry cannot
   * double-apply. No-op for an empty batch.
   *
   * Optional `executor` (M2, dedup follow-up): pass the caller's open `tx`
   * handle to run this UPDATE as part of a LARGER transaction instead of
   * its own — `InvoicesRepository.createBilled` does this so the new
   * invoice, the credit absorption, and the outstanding refresh commit (or
   * roll back) together. Defaults to `this.db` (its own implicit
   * transaction) for every other caller. This is the one place the
   * 'applied' SET shape is written — do not duplicate it elsewhere.
   */
  async markAppliedWithInvoice(
    ids: string[],
    invoiceId: string,
    executor: Db | DbTx = this.db,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await executor
      .update(slaCredits)
      .set({
        status: 'applied',
        appliedInvoiceId: invoiceId,
        appliedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(inArray(slaCredits.id, ids), eq(slaCredits.status, 'pending')));
    return result.rowCount ?? 0;
  }

  async void(id: string): Promise<SlaCredit> {
    const [row] = await this.db
      .update(slaCredits)
      .set({ status: 'void', updatedAt: sql`now()` })
      .where(eq(slaCredits.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('sla credit not found');
    }
    return row;
  }
}
