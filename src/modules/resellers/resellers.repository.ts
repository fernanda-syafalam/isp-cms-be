import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewReseller,
  type Reseller,
  type ResellerLedgerEntry,
  type ResellerPayout,
  resellerLedger,
  resellerPayouts,
  resellers,
} from '../../infrastructure/database/schema/resellers.schema';

// Columns the frontend may sort on (camelCase key → Drizzle column).
// `customerCount` is derived in the service layer (post-query) and is NOT a
// DB column, so it must never appear here.
// Unknown/absent key falls back to `createdAt desc` via buildOrderBy — never throws.
const RESELLER_SORT_WHITELIST = {
  name: resellers.name,
  area: resellers.area,
  balance: resellers.balance,
  commissionPct: resellers.commissionPct,
  status: resellers.status,
  createdAt: resellers.createdAt,
} satisfies Record<string, (typeof resellers)[keyof typeof resellers]>;

// Columns the frontend may sort on for ledger entries.
// Unknown/absent key falls back to `at desc` via buildOrderBy — never throws.
const LEDGER_SORT_WHITELIST = {
  at: resellerLedger.at,
  amount: resellerLedger.amount,
  balanceAfter: resellerLedger.balanceAfter,
  type: resellerLedger.type,
} satisfies Record<string, (typeof resellerLedger)[keyof typeof resellerLedger]>;

// Columns the frontend may sort on for payouts.
// Unknown/absent key falls back to `createdAt desc` via buildOrderBy — never throws.
const PAYOUT_SORT_WHITELIST = {
  amount: resellerPayouts.amount,
  status: resellerPayouts.status,
  createdAt: resellerPayouts.createdAt,
} satisfies Record<string, (typeof resellerPayouts)[keyof typeof resellerPayouts]>;

export interface ResellerListFilter {
  q?: string;
  status?: Reseller['status'];
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface LedgerListFilter {
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface PayoutListFilter {
  status?: ResellerPayout['status'];
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface CreatePayoutInput {
  amount: number;
  note?: string;
  requestedBy: string | null;
}

type ResellerPatch = Partial<Pick<NewReseller, 'name' | 'area' | 'commissionPct' | 'status'>>;

interface LedgerInput {
  type: ResellerLedgerEntry['type'];
  amount: number; // always positive; sign derived from type
  note: string;
  // Idempotency source (P3.D.1) — e.g. the invoice id a commission is for.
  ref?: string;
}

const CREDIT_TYPES = ['topup', 'commission'] as const;

/**
 * The only place that talks to `resellers` / `reseller_ledger`. Returns
 * domain rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class ResellersRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async list(filter: ResellerListFilter): Promise<{ items: Reseller[]; total: number }> {
    const where = and(
      filter.status ? eq(resellers.status, filter.status) : undefined,
      filter.q
        ? or(ilike(resellers.name, `%${filter.q}%`), ilike(resellers.area, `%${filter.q}%`))
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      RESELLER_SORT_WHITELIST,
      desc(resellers.createdAt),
    );

    const items = await this.db
      .select()
      .from(resellers)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(resellers).where(where);
    return { items, total: totals?.value ?? 0 };
  }

  async findById(id: string): Promise<Reseller | null> {
    const [row] = await this.db.select().from(resellers).where(eq(resellers.id, id)).limit(1);
    return row ?? null;
  }

  async update(id: string, patch: ResellerPatch): Promise<Reseller> {
    const [row] = await this.db
      .update(resellers)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(resellers.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('reseller not found');
    }
    return row;
  }

  async listLedger(
    resellerId: string,
    filter: LedgerListFilter,
  ): Promise<{ items: ResellerLedgerEntry[]; total: number }> {
    const where = and(
      eq(resellerLedger.resellerId, resellerId),
      filter.q ? ilike(resellerLedger.note, `%${filter.q}%`) : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      LEDGER_SORT_WHITELIST,
      desc(resellerLedger.at),
    );

    const items = await this.db
      .select()
      .from(resellerLedger)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(resellerLedger).where(where);
    return { items, total: totals?.value ?? 0 };
  }

  /**
   * Append a ledger entry and move the balance atomically. The balance may
   * never go negative — a debit beyond the balance throws 422. Returns the
   * updated reseller.
   */
  async addLedgerEntry(resellerId: string, input: LedgerInput): Promise<Reseller> {
    return this.db.transaction(async (tx) => {
      const [reseller] = await tx
        .select()
        .from(resellers)
        .where(eq(resellers.id, resellerId))
        .limit(1);
      if (!reseller) {
        throw new NotFoundException('reseller not found');
      }

      const signed = (CREDIT_TYPES as readonly string[]).includes(input.type)
        ? input.amount
        : -input.amount;
      const nextBalance = reseller.balance + signed;
      if (nextBalance < 0) {
        throw new UnprocessableEntityException('Saldo tidak mencukupi');
      }

      await tx.insert(resellerLedger).values({
        resellerId,
        type: input.type,
        amount: signed,
        note: input.note,
        balanceAfter: nextBalance,
        ref: input.ref ?? null,
      });
      const [updated] = await tx
        .update(resellers)
        .set({ balance: nextBalance, updatedAt: sql`now()` })
        .where(eq(resellers.id, resellerId))
        .returning();
      if (!updated) {
        throw new NotFoundException('reseller not found');
      }
      return updated;
    });
  }

  /**
   * Post a commission entry for an invoice, idempotently (P3.D.1). Skips (and
   * returns false) when a commission for this reseller+invoice already exists,
   * so replaying a payment never double-credits. Returns true when posted.
   */
  async postCommissionForInvoice(input: {
    resellerId: string;
    amount: number;
    invoiceId: string;
    note: string;
  }): Promise<boolean> {
    const [existing] = await this.db
      .select({ id: resellerLedger.id })
      .from(resellerLedger)
      .where(
        and(
          eq(resellerLedger.resellerId, input.resellerId),
          eq(resellerLedger.type, 'commission'),
          eq(resellerLedger.ref, input.invoiceId),
        ),
      )
      .limit(1);
    if (existing) return false;

    await this.addLedgerEntry(input.resellerId, {
      type: 'commission',
      amount: input.amount,
      note: input.note,
      ref: input.invoiceId,
    });
    return true;
  }

  /** Create a new reseller. Balance always starts at 0 (funded via topup). */
  async create(
    input: Pick<NewReseller, 'name' | 'area' | 'commissionPct' | 'status'>,
  ): Promise<Reseller> {
    const [row] = await this.db.insert(resellers).values(input).returning();
    if (!row) {
      throw new Error('resellers.insert returned no row');
    }
    return row;
  }

  // --- Payout lifecycle (P3.D.4) ---------------------------------------
  //
  // requested -> approved -> paid
  // requested -> rejected
  // `approved`/`rejected`/`paid` never re-enter `requested`; only
  // `disbursePayout` may move a payout into `paid`, and only that method
  // touches the reseller balance / ledger.

  async findPayoutById(id: string): Promise<ResellerPayout | null> {
    const [row] = await this.db
      .select()
      .from(resellerPayouts)
      .where(eq(resellerPayouts.id, id))
      .limit(1);
    return row ?? null;
  }

  async listPayouts(
    resellerId: string,
    filter: PayoutListFilter,
  ): Promise<{ items: ResellerPayout[]; total: number }> {
    const where = and(
      eq(resellerPayouts.resellerId, resellerId),
      filter.status ? eq(resellerPayouts.status, filter.status) : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      PAYOUT_SORT_WHITELIST,
      desc(resellerPayouts.createdAt),
    );

    const items = await this.db
      .select()
      .from(resellerPayouts)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(resellerPayouts).where(where);
    return { items, total: totals?.value ?? 0 };
  }

  /**
   * Request a payout. Only creates the `requested` row — the balance is
   * untouched until `disbursePayout` runs. Throws 422 on a non-positive
   * amount and 404 if the reseller does not exist.
   */
  async createPayout(resellerId: string, input: CreatePayoutInput): Promise<ResellerPayout> {
    if (input.amount <= 0) {
      throw new UnprocessableEntityException('Jumlah payout harus lebih dari 0');
    }
    const reseller = await this.findById(resellerId);
    if (!reseller) {
      throw new NotFoundException('reseller not found');
    }

    const [row] = await this.db
      .insert(resellerPayouts)
      .values({
        resellerId,
        amount: input.amount,
        note: input.note ?? '',
        requestedBy: input.requestedBy,
      })
      .returning();
    if (!row) {
      throw new Error('resellerPayouts.insert returned no row');
    }
    return row;
  }

  /** requested -> approved. Illegal transitions (already decided) throw 422. */
  async approvePayout(payoutId: string, actorId: string | null): Promise<ResellerPayout> {
    return this.transitionPayout(payoutId, 'requested', 'approved', actorId);
  }

  /** requested -> rejected. Illegal transitions (already decided) throw 422. */
  async rejectPayout(payoutId: string, actorId: string | null): Promise<ResellerPayout> {
    return this.transitionPayout(payoutId, 'requested', 'rejected', actorId);
  }

  /**
   * A single-statement conditional UPDATE (`WHERE id = ? AND status = from`)
   * makes the transition atomic: two concurrent approve/reject calls on the
   * same payout race at the DB level and only one can ever match the WHERE
   * clause, so a payout can never be decided twice.
   */
  private async transitionPayout(
    payoutId: string,
    from: ResellerPayout['status'],
    to: 'approved' | 'rejected',
    actorId: string | null,
  ): Promise<ResellerPayout> {
    const [row] = await this.db
      .update(resellerPayouts)
      .set({ status: to, decidedBy: actorId, decidedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(resellerPayouts.id, payoutId), eq(resellerPayouts.status, from)))
      .returning();
    if (row) return row;

    const existing = await this.findPayoutById(payoutId);
    if (!existing) throw new NotFoundException('payout not found');
    throw new UnprocessableEntityException(
      `Payout berstatus '${existing.status}', tidak bisa diproses ke '${to}'`,
    );
  }

  /**
   * Disburse an approved payout: posts a `withdrawal` reseller_ledger entry,
   * decrements the reseller balance, and flips the payout to `paid` — all in
   * one DB transaction so a failure anywhere rolls back everything (no
   * ledger row without a paid payout, no paid payout without a ledger row).
   *
   * Concurrency/idempotency safety:
   *  - `SELECT ... FOR UPDATE` locks the payout row first, so a second
   *    concurrent `disbursePayout` call on the same id blocks until the
   *    first transaction commits or rolls back, then re-reads status and
   *    finds it is no longer `approved` (throws 422 — no double disburse).
   *  - `SELECT ... FOR UPDATE` also locks the reseller row before the
   *    balance check, so two concurrent disbursements against the SAME
   *    reseller (different payouts) cannot both read a stale balance and
   *    both pass the `balance >= amount` guard — they serialize.
   */
  async disbursePayout(payoutId: string): Promise<ResellerPayout> {
    return this.db.transaction(async (tx) => {
      const [payout] = await tx
        .select()
        .from(resellerPayouts)
        .where(eq(resellerPayouts.id, payoutId))
        .for('update')
        .limit(1);
      if (!payout) {
        throw new NotFoundException('payout not found');
      }
      if (payout.status !== 'approved') {
        throw new UnprocessableEntityException(
          `Payout berstatus '${payout.status}', tidak bisa dicairkan`,
        );
      }

      const [reseller] = await tx
        .select()
        .from(resellers)
        .where(eq(resellers.id, payout.resellerId))
        .for('update')
        .limit(1);
      if (!reseller) {
        throw new NotFoundException('reseller not found');
      }
      if (reseller.balance < payout.amount) {
        throw new UnprocessableEntityException('Saldo tidak mencukupi');
      }

      const nextBalance = reseller.balance - payout.amount;
      const [ledgerRow] = await tx
        .insert(resellerLedger)
        .values({
          resellerId: payout.resellerId,
          type: 'withdrawal',
          amount: -payout.amount,
          note: payout.note || 'Pencairan payout',
          balanceAfter: nextBalance,
          ref: payout.id,
        })
        .returning();
      if (!ledgerRow) {
        throw new Error('resellerLedger.insert returned no row');
      }

      await tx
        .update(resellers)
        .set({ balance: nextBalance, updatedAt: sql`now()` })
        .where(eq(resellers.id, payout.resellerId));

      const [updatedPayout] = await tx
        .update(resellerPayouts)
        .set({
          status: 'paid',
          ledgerEntryId: ledgerRow.id,
          // Do NOT overwrite decidedBy/decidedAt here — those record the
          // approve/reject decision (the approver). The disburser + time are
          // captured by @Audit('reseller.payout.disburse') + the linked ledger
          // row, so the approver identity is never lost from the payout row
          // (security-review M1).
          updatedAt: sql`now()`,
        })
        .where(and(eq(resellerPayouts.id, payoutId), eq(resellerPayouts.status, 'approved')))
        .returning();
      if (!updatedPayout) {
        // Unreachable in practice (the row lock above already pinned
        // status='approved' for the lifetime of this tx) — kept as a
        // defensive guard against a double-disburse rather than silently
        // debiting twice.
        throw new UnprocessableEntityException('Payout sedang diproses oleh permintaan lain');
      }
      return updatedPayout;
    });
  }
}
