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
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type Customer,
  type CustomerConnection,
  type NewCustomer,
  customers,
} from '../../infrastructure/database/schema/customers.schema';
import { plans } from '../../infrastructure/database/schema/plans.schema';

// A customer row joined with its plan's display name. planName is never
// stored on the customer (single source of truth lives in plans).
export type CustomerRow = Customer & { planName: string };

export interface CustomerListFilter {
  q?: string;
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
  Pick<NewCustomer, 'fullName' | 'phone' | 'email' | 'address' | 'planId'>
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
  private baseSelect() {
    return this.db
      .select({ ...getTableColumns(customers), planName: plans.name })
      .from(customers)
      .innerJoin(plans, eq(customers.planId, plans.id));
  }

  async list(filter: CustomerListFilter): Promise<{ items: CustomerRow[]; total: number }> {
    const where = and(
      filter.status ? eq(customers.status, filter.status) : undefined,
      filter.q
        ? or(
            ilike(customers.fullName, `%${filter.q}%`),
            ilike(customers.customerNo, `%${filter.q}%`),
            ilike(customers.phone, `%${filter.q}%`),
          )
        : undefined,
      // Multi-value area scope: match any listed area OR unassigned (null).
      // The OR-null rule ensures unassigned customers are never hidden when a
      // branch-scope filter is active.
      filter.area && filter.area.length > 0
        ? or(inArray(customers.areaName, filter.area), isNull(customers.areaName))
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      CUSTOMERS_SORT_WHITELIST,
      asc(customers.fullName),
    );

    const items = await this.baseSelect()
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);

    const [totals] = await this.db.select({ value: count() }).from(customers).where(where);

    return { items, total: totals?.value ?? 0 };
  }

  async findById(id: string): Promise<CustomerRow | null> {
    const [row] = await this.baseSelect().where(eq(customers.id, id)).limit(1);
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

  // How many customers are linked to a reseller name. Customers reference a
  // reseller by name (not FK), so the count is derived here for the
  // resellers module.
  async countByResellerName(resellerName: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(customers)
      .where(eq(customers.resellerName, resellerName));
    return row?.value ?? 0;
  }

  // Bulk customer counts grouped by reseller name (skips unlinked).
  async countsByResellerName(): Promise<Array<{ resellerName: string; count: number }>> {
    const rows = await this.db
      .select({ resellerName: customers.resellerName, value: count() })
      .from(customers)
      .where(isNotNull(customers.resellerName))
      .groupBy(customers.resellerName);
    return rows.flatMap((r) =>
      r.resellerName ? [{ resellerName: r.resellerName, count: r.value }] : [],
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
    opts: { clearOutstanding?: boolean } = {},
  ): Promise<CustomerRow> {
    return this.applyUpdate(id, {
      status,
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
   */
  async findActiveBillable(): Promise<
    Array<{ id: string; fullName: string; planPriceMonthly: number }>
  > {
    return this.db
      .select({
        id: customers.id,
        fullName: customers.fullName,
        planPriceMonthly: plans.priceMonthly,
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
    patch: { outstanding?: number; status?: Customer['status'] },
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
  async findBillingInfo(
    id: string,
  ): Promise<{ fullName: string; planPriceMonthly: number } | null> {
    const [row] = await this.db
      .select({
        fullName: customers.fullName,
        planPriceMonthly: plans.priceMonthly,
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
