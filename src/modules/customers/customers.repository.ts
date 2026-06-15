import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, getTableColumns, ilike, or, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type Customer,
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
  limit: number;
  offset: number;
}

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
          )
        : undefined,
    );

    const items = await this.baseSelect()
      .where(where)
      .orderBy(asc(customers.fullName))
      .limit(filter.limit)
      .offset(filter.offset);

    const [totals] = await this.db.select({ value: count() }).from(customers).where(where);

    return { items, total: totals?.value ?? 0 };
  }

  async findById(id: string): Promise<CustomerRow | null> {
    const [row] = await this.baseSelect().where(eq(customers.id, id)).limit(1);
    return row ?? null;
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
