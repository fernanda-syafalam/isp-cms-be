import { Injectable, NotFoundException } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { type Db, DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type Customer,
  type CustomerConnection,
  type NewCustomer,
  customers,
} from '../../infrastructure/database/schema/customers.schema';
import { invoices } from '../../infrastructure/database/schema/invoices.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';
import { resellers } from '../../infrastructure/database/schema/resellers.schema';
import { slaCredits } from '../../infrastructure/database/schema/sla-credits.schema';
import type { CustomerSummary } from './dto/customer-response.dto';

// Transaction handle type for the private write helpers (same alias as
// InvoicesRepository / VouchersRepository).
type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Same tuple as `InvoicesRepository`'s UNPAID_STATUSES. Duplicated on purpose
// so the money-critical proration transaction is auditable within this file.
const UNPAID_STATUSES = ['pending', 'partial', 'overdue'] as const;

// Customer joined with plan and reseller names (derived, never stored).
// planName: inner join (planId required); resellerName: left join (optional).
export type CustomerRow = Customer & { planName: string; resellerName: string | null };

export interface CustomerListFilter {
  q?: string;
  // Set server-side for mitra principals (P1.5), never from their client
  // input. Staff/admin may also set it from the client (#26).
  resellerId?: string;
  // Ops diagnostic (#25): only customers with reseller_id IS NULL (left by
  // migration 0031's backfill). Wins over resellerId; admin/staff only.
  unassignedReseller?: boolean;
  // KYC-safe projection (ADR-0010 amendment, SEC-4), see baseSelectKycSafe().
  // Set server-side for mitra principals only; never from client input.
  excludeKyc?: boolean;
  status?: Customer['status'];
  // Matches areaName IN this list OR IS NULL (unassigned always visible).
  area?: string[];
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

// Sortable columns (camelCase key → column); unknown key falls back to asc(fullName).
const CUSTOMERS_SORT_WHITELIST = {
  customerNo: customers.customerNo,
  fullName: customers.fullName,
  areaName: customers.areaName,
  status: customers.status,
  joinedAt: customers.createdAt,
} satisfies Record<string, (typeof customers)[keyof typeof customers]>;

// Client-PATCHable fields only; lifecycle, balance and provisioning have dedicated methods.
type ProfilePatch = Partial<
  Pick<NewCustomer, 'fullName' | 'phone' | 'email' | 'address' | 'planId' | 'resellerId'>
>;

/** Sole gate to the `customers` table; returns domain `CustomerRow` (Pilar 3). */
@Injectable()
export class CustomersRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  // planId is NOT NULL with an FK, so the inner join never drops a row.
  // resellerName is derived from resellers.name (M1: a stored copy was never
  // written and would drift on rename); the LEFT JOIN keeps customers with
  // reseller_id IS NULL.
  private baseSelect() {
    return this.db
      .select({ ...getTableColumns(customers), planName: plans.name, resellerName: resellers.name })
      .from(customers)
      .innerJoin(plans, eq(customers.planId, plans.id))
      .leftJoin(resellers, eq(customers.resellerId, resellers.id));
  }

  // KYC-safe projection (ADR-0010 amendment / ADR-0015, SEC-4): npwp/ktp are
  // selected as literal NULL so the identity values never leave Postgres,
  // rather than being nulled later in the mapper. Mitra principals only; all
  // other reads use baseSelect().
  private baseSelectKycSafe() {
    return this.db
      .select({
        ...getTableColumns(customers),
        planName: plans.name,
        resellerName: resellers.name,
        npwp: sql<string | null>`NULL`,
        ktp: sql<string | null>`NULL`,
      })
      .from(customers)
      .innerJoin(plans, eq(customers.planId, plans.id))
      .leftJoin(resellers, eq(customers.resellerId, resellers.id));
  }

  async list(
    filter: CustomerListFilter,
  ): Promise<{ items: CustomerRow[]; total: number; summary: CustomerSummary }> {
    const scopeWhere = this.buildScopeWhere(filter);
    const where = and(
      scopeWhere,
      filter.status ? eq(customers.status, filter.status) : undefined,
      filter.q
        ? or(
            ilike(customers.fullName, `%${filter.q}%`),
            ilike(customers.customerNo, `%${filter.q}%`),
            ilike(customers.phone, `%${filter.q}%`),
          )
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      CUSTOMERS_SORT_WHITELIST,
      asc(customers.fullName),
    );

    const items = await (filter.excludeKyc ? this.baseSelectKycSafe() : this.baseSelect())
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);

    const [totals] = await this.db.select({ value: count() }).from(customers).where(where);

    // Rollup over the access scope only (ignores status/q/paging); one
    // filtered aggregate instead of 5 COUNTs.
    const [summaryRow] = await this.db
      .select({
        total: count(),
        outstanding: sql<string>`coalesce(sum(${customers.outstanding}), 0)`,
        prospek: sql<number>`count(*) filter (where ${customers.status} = 'prospek')`,
        instalasi: sql<number>`count(*) filter (where ${customers.status} = 'instalasi')`,
        aktif: sql<number>`count(*) filter (where ${customers.status} = 'aktif')`,
        isolir: sql<number>`count(*) filter (where ${customers.status} = 'isolir')`,
        berhenti: sql<number>`count(*) filter (where ${customers.status} = 'berhenti')`,
      })
      .from(customers)
      .where(scopeWhere);

    const summary: CustomerSummary = {
      total: summaryRow?.total ?? 0,
      outstanding: Number(summaryRow?.outstanding ?? 0),
      byStatus: {
        prospek: Number(summaryRow?.prospek ?? 0),
        instalasi: Number(summaryRow?.instalasi ?? 0),
        aktif: Number(summaryRow?.aktif ?? 0),
        isolir: Number(summaryRow?.isolir ?? 0),
        berhenti: Number(summaryRow?.berhenti ?? 0),
      },
    };

    return { items, total: totals?.value ?? 0, summary };
  }

  // Access-scope predicate shared by the paged query and the summary. status/q
  // are excluded so the summary stays stable across status tabs and searches.
  private buildScopeWhere(filter: CustomerListFilter) {
    return and(
      // OR-null keeps unassigned customers visible under a branch scope.
      filter.area && filter.area.length > 0
        ? or(inArray(customers.areaName, filter.area), isNull(customers.areaName))
        : undefined,
      filter.unassignedReseller
        ? isNull(customers.resellerId)
        : filter.resellerId
          ? eq(customers.resellerId, filter.resellerId)
          : undefined,
    );
  }

  // `excludeKyc` (SEC-4): pass true only once the requester is established as
  // a mitra principal; defaults to the full row for internal callers.
  async findById(id: string, opts: { excludeKyc?: boolean } = {}): Promise<CustomerRow | null> {
    const [row] = await (opts.excludeKyc ? this.baseSelectKycSafe() : this.baseSelect())
      .where(eq(customers.id, id))
      .limit(1);
    return row ?? null;
  }

  // Batched findById for the billing cron (R6-DB-2); order is unspecified
  // (callers key by id). Empty input skips the query: `inArray(col, [])` is a
  // SQL error on some drivers.
  async findByIds(ids: string[]): Promise<CustomerRow[]> {
    if (ids.length === 0) return [];
    return this.baseSelect().where(inArray(customers.id, ids));
  }

  // Fallback for portal sessions predating the userId linkage (P1.3).
  async findByEmail(email: string): Promise<CustomerRow | null> {
    const [row] = await this.baseSelect().where(eq(customers.email, email)).limit(1);
    return row ?? null;
  }

  // Authoritative portal-session mapping via customers.user_id (P1.3).
  async findByUserId(userId: string): Promise<CustomerRow | null> {
    const [row] = await this.baseSelect().where(eq(customers.userId, userId)).limit(1);
    return row ?? null;
  }

  // Keyed by the FK, not a name match, which undercounts after a rename (M1).
  async countByResellerId(resellerId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(customers)
      .where(eq(customers.resellerId, resellerId));
    return row?.value ?? 0;
  }

  // Bulk customer counts grouped by reseller id (skips unlinked).
  async countsByResellerId(): Promise<Array<{ resellerId: string; count: number }>> {
    const rows = await this.db
      .select({ resellerId: customers.resellerId, value: count() })
      .from(customers)
      .where(isNotNull(customers.resellerId))
      .groupBy(customers.resellerId);
    return rows.flatMap((r) =>
      r.resellerId ? [{ resellerId: r.resellerId, count: r.value }] : [],
    );
  }

  // First exact full-name match, for modules that reference subscribers by name (tickets).
  async findIdByFullName(fullName: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.fullName, fullName))
      .limit(1);
    return row?.id ?? null;
  }

  async create(input: NewCustomer): Promise<CustomerRow> {
    const [inserted] = await this.db
      .insert(customers)
      .values(input)
      .returning({ id: customers.id });
    if (!inserted) {
      throw new Error('customers.insert returned no row');
    }
    return this.requireById(inserted.id);
  }

  async updateProfile(id: string, patch: ProfilePatch): Promise<CustomerRow> {
    const updated = await this.applyUpdate(id, { ...patch });
    return updated;
  }

  /**
   * Changes the plan and applies the proration delta in one transaction
   * (PR #121 MUST-FIX #1/#5). The row is locked FOR UPDATE and `planId` is
   * re-read under the lock, never from a caller's pre-lock snapshot, so
   * concurrent or retried calls to the same target plan cannot both apply the
   * delta. If `planId` already equals the target, returns
   * `{ applied: false, delta: 0 }` (idempotent no-op). `dueDays` sets the
   * adjustment invoice's due date (see `applyDeltaTx`).
   */
  async changePlan(
    id: string,
    input: { targetPlanId: string; dueDays: number },
  ): Promise<{ applied: boolean; delta: number }> {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ planId: customers.planId, fullName: customers.fullName })
        .from(customers)
        .where(eq(customers.id, id))
        .for('update')
        .limit(1);
      if (!locked) {
        throw new NotFoundException('customer not found');
      }
      if (locked.planId === input.targetPlanId) {
        return { applied: false, delta: 0 }; // idempotent no-op — see method doc.
      }

      const [newPlan] = await tx
        .select({ id: plans.id, name: plans.name, priceMonthly: plans.priceMonthly })
        .from(plans)
        .where(eq(plans.id, input.targetPlanId))
        .limit(1);
      if (!newPlan) {
        // The service pre-validates; a miss means the plan vanished before the lock.
        throw new NotFoundException('plan not found');
      }
      const [oldPlan] = await tx
        .select({ id: plans.id, name: plans.name, priceMonthly: plans.priceMonthly })
        .from(plans)
        .where(eq(plans.id, locked.planId))
        .limit(1);
      const delta = oldPlan ? newPlan.priceMonthly - oldPlan.priceMonthly : 0;

      await tx
        .update(customers)
        .set({ planId: input.targetPlanId, updatedAt: sql`now()` })
        .where(eq(customers.id, id));

      if (delta !== 0) {
        await this.applyDeltaTx(tx, id, {
          delta,
          customerName: locked.fullName,
          note: `Proration plan change: ${oldPlan?.name ?? 'unknown'} -> ${newPlan.name}`,
          dueDays: input.dueDays,
        });
      }

      return { applied: true, delta };
    });
  }

  /**
   * Applies a standalone money delta through a real invoice line, never by
   * writing `outstanding` directly: it is derived from unpaid invoices
   * (`InvoicesRepository.sumUnpaidByCustomer`), so a delta without a backing
   * invoice is erased by the next recompute. For plan changes use
   * `changePlan`, which computes the delta under the customer lock; passing
   * an externally computed delta here reopens the MUST-FIX #1 race.
   * See `applyDeltaTx` for charge/credit modeling.
   */
  async applyProration(
    id: string,
    input: { delta: number; customerName: string; note: string; dueDays: number },
  ): Promise<void> {
    if (input.delta === 0) return;
    await this.db.transaction(async (tx) => {
      await this.applyDeltaTx(tx, id, input);
    });
  }

  /**
   * `delta > 0` (charge): inserts an `adjustment` invoice. Its period is today
   * so it cannot collide with the monthly invoice; `invoices_customer_period_idx`
   * is partial (`WHERE type = 'regular'`) to exempt adjustments. `dueDate` is
   * today + `dueDays`, the same grace as a regular invoice (MED #4): with
   * `dueDate = today`, overdue marking and isolation would hit the customer
   * the next day.
   *
   * `delta < 0` (credit): see `applyCreditTx`.
   *
   * `customers.outstanding` is refreshed in the same transaction so a later
   * recompute cannot wipe the adjustment.
   *
   * Cross-table writes (`invoices`, `sla_credits`) are the same money-path
   * exception as `InvoicesRepository.recordPayment` / `VouchersRepository.settle`.
   * Lock order is INVOICE then CUSTOMER LAST (as in `recordPayment` /
   * `refreshOutstandingTx`), so concurrent payments only serialize on the
   * customer row and never deadlock.
   */
  private async applyDeltaTx(
    tx: DbTx,
    id: string,
    input: { delta: number; customerName: string; note: string; dueDays: number },
  ): Promise<void> {
    if (input.delta > 0) {
      const today = isoToday();
      await tx.insert(invoices).values({
        customerId: id,
        customerName: input.customerName,
        type: 'adjustment',
        note: input.note,
        periodStart: today,
        periodEnd: today,
        dueDate: isoPlusDays(input.dueDays),
        amount: input.delta,
        status: 'pending',
      });
    } else {
      await this.applyCreditTx(tx, id, Math.abs(input.delta), input.customerName, input.note);
    }
    await this.refreshOutstandingTx(tx, id);
  }

  /**
   * Applies a credit to the customer's oldest unpaid invoice (by due date),
   * locked FOR UPDATE so concurrent payments/credits serialize. Never spread
   * across invoices.
   *
   * MED #3 ("credit vanishes"): with no unpaid invoice, or a credit larger
   * than the balance due, the WHOLE credit is deferred as a pending
   * `sla_credits` row (absorbed by `InvoicesService.resolveSlaDiscount` on the
   * next billing run). A partial-now split would double count because that
   * absorption cannot know part was already spent.
   */
  private async applyCreditTx(
    tx: DbTx,
    customerId: string,
    amount: number,
    customerName: string,
    reason: string,
  ): Promise<void> {
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

    if (invoice && balanceDue >= amount) {
      await tx
        .update(invoices)
        .set({ discountAmount: sql`${invoices.discountAmount} + ${amount}`, updatedAt: sql`now()` })
        .where(eq(invoices.id, invoice.id));
      return;
    }

    // Defer the whole credit (see method doc).
    await tx.insert(slaCredits).values({
      customerId,
      customerName,
      amount,
      reason,
      status: 'pending',
    });
  }

  /**
   * Recomputes `customers.outstanding` with the expression from
   * `InvoicesRepository.sumUnpaidByCustomer`, in the caller's transaction.
   * The customer row is locked FOR UPDATE last (see `applyDeltaTx` lock order).
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

  /** Move the customer: new address + service area. */
  async relocate(id: string, patch: { address: string; areaName: string }): Promise<CustomerRow> {
    return this.applyUpdate(id, patch);
  }

  /** Moves lifecycle status; `clearOutstanding` zeroes the balance (activate-after-payment). */
  async setStatus(
    id: string,
    status: Customer['status'],
    opts: { clearOutstanding?: boolean; holdReason?: Customer['holdReason'] } = {},
  ): Promise<CustomerRow> {
    return this.applyUpdate(id, {
      status,
      // Only `isolir` carries a reason (P3.A.3).
      holdReason: status === 'isolir' ? (opts.holdReason ?? 'overdue') : null,
      ...(opts.clearOutstanding ? { outstanding: 0 } : {}),
    });
  }

  /**
   * Swaps the `isolir` holdReason (overdue <-> voluntary, P3.A.3) without
   * touching `status`; the service's same-state guard rejects isolir -> isolir
   * (D6/NL-2). Precondition enforced in `CustomersService.reclassifyHold`.
   */
  async reclassifyHold(id: string, holdReason: Customer['holdReason']): Promise<CustomerRow> {
    return this.applyUpdate(id, { holdReason });
  }

  // consent_at uses the DB clock, which applyUpdate's typed patch cannot express.
  async recordConsent(id: string): Promise<CustomerRow> {
    const [updated] = await this.db
      .update(customers)
      .set({ consentAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(customers.id, id))
      .returning({ id: customers.id });
    if (!updated) {
      throw new NotFoundException('customer not found');
    }
    return this.requireById(updated.id);
  }

  async updateKyc(id: string, kyc: { ktp: string; npwp: string | null }): Promise<CustomerRow> {
    return this.applyUpdate(id, { ktp: kyc.ktp, npwp: kyc.npwp });
  }

  /** Records the erasure request time; anonymization runs as a job elsewhere. */
  async requestDataDeletion(id: string): Promise<void> {
    const result = await this.db
      .update(customers)
      .set({ dataDeletionRequestedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(customers.id, id));
    if (result.rowCount === 0) {
      throw new NotFoundException('customer not found');
    }
  }

  // --- Billing support ------------------------------------------------

  /**
   * Active customers with plan monthly price, for a billing run.
   * `billingAnchorDay` (P3.A.4) drives the due date; null falls back to the
   * SettingsService dueDays policy.
   */
  async findActiveBillable(): Promise<
    Array<{
      id: string;
      fullName: string;
      planPriceMonthly: number;
      billingAnchorDay: number | null;
    }>
  > {
    return this.db
      .select({
        id: customers.id,
        fullName: customers.fullName,
        planPriceMonthly: plans.priceMonthly,
        billingAnchorDay: customers.billingAnchorDay,
      })
      .from(customers)
      .innerJoin(plans, eq(customers.planId, plans.id))
      .where(eq(customers.status, 'aktif'));
  }

  /** Sets outstanding and/or status (e.g. reactivate from isolir once paid up). */
  async setBilling(
    id: string,
    patch: {
      outstanding?: number;
      status?: Customer['status'];
      holdReason?: Customer['holdReason'];
    },
  ): Promise<void> {
    const result = await this.db
      .update(customers)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(customers.id, id));
    if (result.rowCount === 0) {
      throw new NotFoundException('customer not found');
    }
  }

  // --- Satisfaction support -------------------------------------------

  /** Total customers — denominator for churn / NPS aggregates. */
  async countAll(): Promise<number> {
    const [row] = await this.db.select({ value: count() }).from(customers);
    return row?.value ?? 0;
  }

  /** Churn-risk subscribers: isolated or carrying a balance (debt first). */
  async findAtRisk(
    limit: number,
  ): Promise<
    Array<{ id: string; fullName: string; status: Customer['status']; outstanding: number }>
  > {
    return this.db
      .select({
        id: customers.id,
        fullName: customers.fullName,
        status: customers.status,
        outstanding: customers.outstanding,
      })
      .from(customers)
      .where(or(eq(customers.status, 'isolir'), gt(customers.outstanding, 0)))
      .orderBy(desc(customers.outstanding))
      .limit(limit);
  }

  // Provisioned subscribers (aktif/isolir) with plan name + speed, for the usage module.
  async findForUsage(): Promise<
    Array<{ id: string; fullName: string; planName: string; planSpeedMbps: number }>
  > {
    return this.db
      .select({
        id: customers.id,
        fullName: customers.fullName,
        planName: plans.name,
        planSpeedMbps: plans.speedMbps,
      })
      .from(customers)
      .innerJoin(plans, eq(customers.planId, plans.id))
      .where(inArray(customers.status, ['aktif', 'isolir']))
      .orderBy(asc(customers.fullName));
  }

  // --- Provisioning support (work orders) -----------------------------

  /** Plan price + name for a single customer, for first-invoice billing. */
  async findBillingInfo(id: string): Promise<{
    fullName: string;
    planPriceMonthly: number;
    billingAnchorDay: number | null;
  } | null> {
    const [row] = await this.db
      .select({
        fullName: customers.fullName,
        planPriceMonthly: plans.priceMonthly,
        billingAnchorDay: customers.billingAnchorDay,
      })
      .from(customers)
      .innerJoin(plans, eq(customers.planId, plans.id))
      .where(eq(customers.id, id))
      .limit(1);
    return row ?? null;
  }

  /** Mark a customer active and attach the provisioned connection. */
  async markInstalled(id: string, connection: CustomerConnection): Promise<void> {
    const result = await this.db
      .update(customers)
      .set({ status: 'aktif', connection, updatedAt: sql`now()` })
      .where(eq(customers.id, id));
    if (result.rowCount === 0) {
      throw new NotFoundException('customer not found');
    }
  }

  // --- Analytics support ----------------------------------------------
  // Aggregate reads for analytics, which owns no table (Pilar 3).

  /** Subscriber counts grouped by lifecycle status (every status present). */
  async countByStatus(): Promise<Record<Customer['status'], number>> {
    const rows = await this.db
      .select({ status: customers.status, value: count() })
      .from(customers)
      .groupBy(customers.status);
    const result: Record<Customer['status'], number> = {
      prospek: 0,
      instalasi: 0,
      aktif: 0,
      isolir: 0,
      berhenti: 0,
    };
    for (const row of rows) {
      result[row.status] = row.value;
    }
    return result;
  }

  /** Customers created on/after `since` — the "new this period" KPI. */
  async countCreatedSince(since: Date): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(customers)
      .where(gte(customers.createdAt, since));
    return row?.value ?? 0;
  }

  /** Churn-risk subscribers: isolated or carrying a balance. */
  async countAtRisk(): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(customers)
      .where(or(eq(customers.status, 'isolir'), gt(customers.outstanding, 0)));
    return row?.value ?? 0;
  }

  /** New subscribers per calendar month (UTC, YYYY-MM) since `since`. */
  async countCreatedByMonth(since: Date): Promise<Array<{ month: string; count: number }>> {
    const rows = await this.db
      .select({
        month: sql<string>`to_char(${customers.createdAt} at time zone 'UTC', 'YYYY-MM')`,
        value: count(),
      })
      .from(customers)
      .where(gte(customers.createdAt, since))
      .groupBy(sql`to_char(${customers.createdAt} at time zone 'UTC', 'YYYY-MM')`);
    return rows.map((row) => ({ month: row.month, count: row.value }));
  }

  /** Churned per month since `since`, keyed by updated_at (no churn timestamp column). */
  async countChurnedByMonth(since: Date): Promise<Array<{ month: string; count: number }>> {
    const rows = await this.db
      .select({
        month: sql<string>`to_char(${customers.updatedAt} at time zone 'UTC', 'YYYY-MM')`,
        value: count(),
      })
      .from(customers)
      .where(and(eq(customers.status, 'berhenti'), gte(customers.updatedAt, since)))
      .groupBy(sql`to_char(${customers.updatedAt} at time zone 'UTC', 'YYYY-MM')`);
    return rows.map((row) => ({ month: row.month, count: row.value }));
  }

  // Shared update path: bumps updated_at, 404s on a missing id, re-reads for joined names.
  private async applyUpdate(id: string, set: Partial<NewCustomer>): Promise<CustomerRow> {
    const [updated] = await this.db
      .update(customers)
      .set({ ...set, updatedAt: sql`now()` })
      .where(eq(customers.id, id))
      .returning({ id: customers.id });
    if (!updated) {
      throw new NotFoundException('customer not found');
    }
    return this.requireById(updated.id);
  }

  private async requireById(id: string): Promise<CustomerRow> {
    const row = await this.findById(id);
    if (!row) {
      // We just wrote this row; a miss is an invariant violation, not a 404.
      throw new Error('customers row vanished after write');
    }
    return row;
  }
}

// Today as UTC 'YYYY-MM-DD'; mirrors `InvoicesService`'s date helpers.
function isoToday(): string {
  return isoPlusDays(0);
}

// UTC 'YYYY-MM-DD', `days` from today (adjustment dueDate, MED #4).
function isoPlusDays(days: number): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + days);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${now.getUTCFullYear()}-${mm}-${dd}`;
}
