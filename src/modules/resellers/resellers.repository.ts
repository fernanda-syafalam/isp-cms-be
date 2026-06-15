import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { count, desc, eq, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewReseller,
  type Reseller,
  type ResellerLedgerEntry,
  resellerLedger,
  resellers,
} from '../../infrastructure/database/schema/resellers.schema';

export interface ResellerListFilter {
  status?: Reseller['status'];
  limit: number;
  offset: number;
}

type ResellerPatch = Partial<Pick<NewReseller, 'name' | 'area' | 'commissionPct' | 'status'>>;

interface LedgerInput {
  type: ResellerLedgerEntry['type'];
  amount: number; // always positive; sign derived from type
  note: string;
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
    const where = filter.status ? eq(resellers.status, filter.status) : undefined;
    const items = await this.db
      .select()
      .from(resellers)
      .where(where)
      .orderBy(desc(resellers.createdAt))
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

  async listLedger(resellerId: string): Promise<{ items: ResellerLedgerEntry[]; total: number }> {
    const items = await this.db
      .select()
      .from(resellerLedger)
      .where(eq(resellerLedger.resellerId, resellerId))
      .orderBy(desc(resellerLedger.at));
    return { items, total: items.length };
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
}
