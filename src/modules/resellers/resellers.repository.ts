import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewReseller,
  type Reseller,
  type ResellerLedgerEntry,
  resellerLedger,
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
}
