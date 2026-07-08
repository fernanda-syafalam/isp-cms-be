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

// The transaction handle drizzle hands its callback — used to type
// `applyProration`'s private write helpers without an `any` (mirrors
// InvoicesRepository / VouchersRepository's identical local alias).
type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Statuses that still owe money — the exact same tuple
// `InvoicesRepository` uses for `sumUnpaidByCustomer` / `UNPAID_STATUSES`.
// Duplicated locally (not imported) so this money-critical transaction is
// self-contained and auditable within this one file, same convention as
// `InvoicesService.formatIdr` being deliberately duplicated rather than
// shared across modules.
const UNPAID_STATUSES = ['pending', 'partial', 'overdue'] as const;

// A customer row joined with its plan's display name. planName is never
// stored on the customer (single source of truth lives in plans).
export type CustomerRow = Customer & { planName: string };

export interface CustomerListFilter {
  q?: string;
  // Scope to one reseller's acquisitions — set server-side for mitra
  // principals (P1.5), never taken from client input for them. Staff/admin
  // may also set this from the client (#26) to view one reseller's
  // customers without filtering the full list.
  resellerId?: string;
  // Ops diagnostic (#25): return only customers left with reseller_id IS
  // NULL after migration 0031's backfill (ambiguous/no name match), so
  // they can be found and reconciled. Takes precedence over resellerId if
  // both are somehow set (the controller DTO already rejects that
  // combination) — admin/staff only, same access boundary as resellerId.
  unassignedReseller?: boolean;
  // KYC-safe projection (ADR-0010 amendment, SEC-4): when true, npwp/ktp
  // are never read off the real column — see baseSelectKycSafe(). Set
  // server-side by CustomersService for mitra principals only; never
  // taken from client input.
  excludeKyc?: boolean;
  status?: Customer['status'];
  // Repeatable area filter: return customers whose areaName is IN this list
  // OR whose areaName IS NULL (unassigned customers are always visible).
  // Absent = no area constraint.
  area?: string[];
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

// Columns the frontend may sort on (camelCase key → Drizzle column).
// Unknown/absent key falls back to `asc(fullName)` via buildOrderBy — never throws.
const CUSTOMERS_SORT_WHITELIST = {
  customerNo: customers.customerNo,
  fullName: customers.fullName,
  areaName: customers.areaName,
  status: customers.status,
  joinedAt: customers.createdAt,
} satisfies Record<string, (typeof customers)[keyof typeof customers]>;

// Mutable base-profile fields a client may PATCH. Lifecycle, balance and
// provisioning are NOT here — they move through dedicated methods.
type ProfilePatch = Partial<
  Pick<NewCustomer, 'fullName' | 'phone' | 'email' | 'address' | 'planId' | 'resellerId'>
>;

/**
 * The only place that talks to the `customers` table. Returns domain
 * `CustomerRow` (customer + joined planName) — never Drizzle tuples or
 * raw SQL (Pilar 3).
 */
@Injectable()
export class CustomersRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  // Every read returns the customer columns plus the joined plan name.
  // planId is NOT NULL with an FK, so an inner join never drops a row.
  //
  // resellerName is DERIVED here from resellers.name via a LEFT JOIN, not
  // read from the stored customers.reseller_name column: no create/update
  // path ever writes that column (M1 prod-only bug — mitra reads/KPIs key
  // off resellerName and saw it permanently empty), and a stored copy would
  // drift whenever a reseller is renamed anyway. The LEFT JOIN (not INNER)
  // is required so a customer with no reseller (reseller_id IS NULL) is
  // still returned, with resellerName: null. The explicit `resellerName:
  // resellers.name` key below overrides the stale spread column from
  // getTableColumns(customers) — object literal key order means the later
  // key wins.
  private baseSelect() {
    return this.db
      .select({ ...getTableColumns(customers), planName: plans.name, resellerName: resellers.name })
      .from(customers)
      .innerJoin(plans, eq(customers.planId, plans.id))
      .leftJoin(resellers, eq(customers.resellerId, resellers.id));
  }

  // KYC-safe projection (ADR-0010 amendment / ADR-0015, SEC-4): npwp/ktp
  // are replaced with a literal SQL NULL instead of the real column, so
  // the identity values are never read out of Postgres for this query —
  // not merely nulled after the fact in the response mapper. Used by
  // list()/findById() only when the caller has been established as a
  // mitra principal (CustomersService); every other read path
  // (admin/staff, and the many internal cross-module callers of
  // CustomersService.findById that never pass a user) keeps using
  // baseSelect() above, unchanged.
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

    // Scope-wide lifecycle-status + outstanding rollup — computed over the
    // caller's ACCESS SCOPE (area/resellerId, same as `scopeWhere` above),
    // ignoring status/q/paging (mirrors the work-orders/invoices summary
    // aggregate). A single grouped-filter aggregate avoids 5 separate COUNT
    // queries; missing statuses are zero-filled below.
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

  // The caller's access-scope predicate (area/resellerId) shared by both the
  // paged `where` and the summary aggregate — status/q are deliberately
  // excluded here since the summary must stay stable while a user switches
  // status tabs or types a search query (mirrors the FE mock contract: the
  // branch scope applies before the status filter).
  private buildScopeWhere(filter: CustomerListFilter) {
    return and(
      // Multi-value area scope: match any listed area OR unassigned (null).
      // The OR-null rule ensures unassigned customers are never hidden when a
      // branch-scope filter is active.
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

  // `excludeKyc` (ADR-0010 amendment / ADR-0015, SEC-4): pass `true` only
  // from a caller that has already established the requester is a mitra
  // principal — see baseSelectKycSafe(). Defaults to false (full row) so
  // every existing internal caller (the many cross-module
  // `CustomersService.findById(id)` call sites that pass no user) is
  // unaffected.
  async findById(id: string, opts: { excludeKyc?: boolean } = {}): Promise<CustomerRow | null> {
    const [row] = await (opts.excludeKyc ? this.baseSelectKycSafe() : this.baseSelect())
      .where(eq(customers.id, id))
      .limit(1);
    return row ?? null;
  }

  // Resolve a customer by their (unique-in-practice) email. Transition
  // fallback for portal sessions predating the userId linkage (P1.3).
  async findByEmail(email: string): Promise<CustomerRow | null> {
    const [row] = await this.baseSelect().where(eq(customers.email, email)).limit(1);
    return row ?? null;
  }

  // Resolve a customer by their linked login (customers.user_id, unique).
  // The authoritative portal-session mapping (P1.3).
  async findByUserId(userId: string): Promise<CustomerRow | null> {
    const [row] = await this.baseSelect().where(eq(customers.userId, userId)).limit(1);
    return row ?? null;
  }

  // How many customers are linked to a reseller, keyed by the FK
  // (resellerId) — not a name match, which would silently undercount the
  // moment a reseller is renamed (same drift class as M1). Used by the
  // resellers module for the per-reseller customerCount.
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

  // Resolve a customer id from an exact full-name match (first hit). Used
  // by modules that reference a subscriber by name (e.g. tickets).
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
   * Atomically change a customer's plan AND apply the resulting proration —
   * MUST-FIX #1/#5 (PR #121 money review): the plan write and the delta
   * charge/credit succeed or fail together, and the whole decision is made
   * under ONE lock so two concurrent OR retried calls to the SAME target
   * plan can never both apply the delta (double-charge / double-credit).
   *
   * Locks the customer row `FOR UPDATE` FIRST, then RE-READS `planId`
   * under that lock — never a caller's outer, pre-lock snapshot (the old
   * bug: `CustomersService.changePlan` read `planId` via `requireById()`
   * OUTSIDE any transaction, so two concurrent submits both saw the OLD
   * plan, both computed the same delta, and both created their own
   * adjustment invoice). If the locked row's `planId` already equals
   * `targetPlanId`, this is a pure no-op — a concurrent call (or a retried
   * request) already won this race and committed; `{ applied: false,
   * delta: 0 }` is returned so the caller can tell idempotent-no-op apart
   * from a genuine change. Only the winner computes the delta, from plan
   * prices read inside this SAME transaction, and applies it via
   * `applyDeltaTx`.
   *
   * `dueDays` (the billing policy's grace period) is threaded through to
   * the adjustment invoice's due date — see `applyDeltaTx` / MED #4.
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
        // The service already validates this before calling in — a miss
        // here means the plan vanished between that check and this lock
        // (extremely rare). Surfaced the same way `requireById` surfaces a
        // vanished row: a real invariant violation, not routine input.
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
   * Apply a standalone money delta to a customer's balance via a REAL
   * invoice line — never a hand-computed delta written straight onto
   * `outstanding` (that was the silent-wipe bug: `outstanding` is a
   * DERIVED column, recomputed from unpaid invoices on every billing event
   * — see `InvoicesRepository.sumUnpaidByCustomer` — so a bare delta with
   * no backing invoice row gets silently erased by the next recompute).
   * Kept as its own entry point (over and above `changePlan`, which calls
   * the same underlying `applyDeltaTx`) for any future caller that already
   * knows a correct, race-free delta — e.g. a manual admin adjustment.
   * `changePlan` is the one to use for a plan-change specifically: it
   * computes the delta itself, atomically, under the customer lock (see
   * its own doc for why calling this method with an externally
   * pre-computed delta is exactly the race MUST-FIX #1 closed).
   *
   * See `applyDeltaTx` for the charge/credit modeling.
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
   * `delta > 0` (charge, e.g. an upgrade): inserts a new `type:
   * 'adjustment'` invoice for the delta — a real charge with its own
   * balanceDue. `periodStart`/`periodEnd` are today's date, not the
   * billing-cycle month, so it can never collide with the customer's
   * regular monthly invoice under `invoices_customer_period_idx` — that
   * index is now partial (`WHERE type = 'regular'`) precisely so
   * adjustment lines are exempt from the one-invoice-per-period rule.
   * `dueDate = today + dueDays` — the SAME grace period a regular invoice
   * gets (MED #4, PR #121 review): a bare `dueDate = today` let
   * `markOverduePastDue` flip it overdue the very next day and
   * `isolateActiveDebtors` cut service for a small proration charge with
   * zero grace.
   *
   * `delta < 0` (credit, e.g. a downgrade): applied via `applyCreditTx` —
   * see that method's doc for the full-coverage-or-defer modeling (MED
   * #3).
   *
   * Either way, `customers.outstanding` is refreshed at the end from the
   * exact same expression `sumUnpaidByCustomer` uses, in the SAME
   * transaction — so the adjustment can never be wiped by a later
   * recompute.
   *
   * This is the same deliberate "one repository per table" exception
   * `InvoicesRepository.recordPayment` / `VouchersRepository.settle`
   * document: `CustomersRepository` reaches into `invoices` (and, via
   * `applyCreditTx`, `sla_credits`) directly so the adjustment line and the
   * outstanding refresh share one transaction. The lock order is INVOICE
   * (when the credit branch touches one) THEN CUSTOMER LAST, right before
   * the recompute — the exact order `InvoicesRepository.recordPayment` /
   * `refreshOutstandingTx` use — so a concurrent payment/credit against the
   * same customer can only ever serialize on the shared customer-row lock,
   * never deadlock against this method (neither side ever acquires an
   * invoice lock AFTER a customer lock it already holds).
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
   * Apply a credit (downgrade proration, or a future caller's) to the
   * customer's single oldest unpaid invoice, by due date — see
   * `applyDeltaTx`'s doc for why this never spreads across multiple
   * invoices. `SELECT ... FOR UPDATE` locks the chosen invoice row so a
   * concurrent payment/credit against it serializes instead of racing.
   *
   * MED #3 (PR #121 money review — "credit vanishes"): if the customer has
   * no unpaid invoice at all, OR the credit is LARGER than that invoice's
   * balance due, this does NOT partially discount it — a partial-now /
   * implicit-remainder-later split would double count, because a future
   * billing run's SLA-credit absorption (`InvoicesService
   * .resolveSlaDiscount`) has no concept of "this credit was already
   * partly spent." Instead the WHOLE credit is deferred by inserting a
   * pending `sla_credits` row — the exact same pending-absorption
   * mechanism a real SLA credit already uses
   * (`findPendingByCustomer` -> `resolveSlaDiscount` -> `absorbSlaCredits`),
   * so a future billing run picks it up in full. The credit the customer
   * earned is never silently dropped — only ever fully applied now, or
   * fully deferred.
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

    // Defer the WHOLE credit — see method doc.
    await tx.insert(slaCredits).values({
      customerId,
      customerName,
      amount,
      reason,
      status: 'pending',
    });
  }

  /**
   * Recompute `customers.outstanding` from the exact same expression
   * `InvoicesRepository.sumUnpaidByCustomer` uses and persist it, inside
   * the caller's transaction — mirrors
   * `InvoicesRepository.refreshOutstandingTx`. The customer row is locked
   * FOR UPDATE immediately before the recompute (the LAST lock this
   * transaction takes) so a concurrent write following the same
   * lock-then-recompute discipline can only serialize against this one,
   * never deadlock.
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

  /**
   * Move the customer to a new lifecycle status. `clearOutstanding`
   * zeroes the balance (used by activate-after-payment); the other
   * transitions leave the balance untouched.
   */
  async setStatus(
    id: string,
    status: Customer['status'],
    opts: { clearOutstanding?: boolean; holdReason?: Customer['holdReason'] } = {},
  ): Promise<CustomerRow> {
    return this.applyUpdate(id, {
      status,
      // `isolir` carries the reason (overdue vs voluntary/cuti); any other
      // status clears it (P3.A.3).
      holdReason: status === 'isolir' ? (opts.holdReason ?? 'overdue') : null,
      ...(opts.clearOutstanding ? { outstanding: 0 } : {}),
    });
  }

  // consent_at is set to the DB clock (sql `now()`), which the typed
  // ProfilePatch set of applyUpdate cannot express — do it directly.
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

  /**
   * Mark that an erasure was requested. The actual anonymization is an
   * async job owned elsewhere — this only records the request time.
   */
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
  // The billing module owns a customer's balance/lifecycle-by-payment.
  // These two methods are the seam it uses; the logic lives there.

  /**
   * Active customers with their plan's monthly price — the input to a
   * billing run. Joins plans for the price (never stored on the customer).
   * `billingAnchorDay` (P3.A.4) drives the invoice due date when set; null
   * falls back to the global SettingsService dueDays policy.
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

  /**
   * Apply a billing effect: set the outstanding balance and/or move the
   * lifecycle status (e.g. reactivate from isolir once paid up).
   */
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

  // Provisioned subscribers (aktif/isolir) joined with plan name + speed —
  // the input the usage module computes data-consumption from.
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
  // Aggregate reads for the dashboard/reports rollup. The analytics module
  // owns no table, so every count it needs is derived here (Pilar 3).

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

  /**
   * Churned subscribers per calendar month (YYYY-MM) since `since`, keyed by
   * the time the status moved to `berhenti` (its updated_at — there is no
   * dedicated churn timestamp yet).
   */
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

  // Shared update path: always bumps updated_at, throws NotFound when the
  // id is absent, then re-reads to attach the joined planName.
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
      // The row existed a moment ago (we just wrote it) — a miss here is
      // a real invariant violation, not a normal 404.
      throw new Error('customers row vanished after write');
    }
    return row;
  }
}

// Whole-day UTC 'YYYY-MM-DD' for the day a proration adjustment invoice is
// raised on — mirrors `InvoicesService`'s local date helpers.
function isoToday(): string {
  return isoPlusDays(0);
}

// Whole-day UTC 'YYYY-MM-DD', `days` from today — used for an adjustment
// invoice's dueDate (today + the billing policy's grace days, MED #4).
function isoPlusDays(days: number): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + days);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${now.getUTCFullYear()}-${mm}-${dd}`;
}
