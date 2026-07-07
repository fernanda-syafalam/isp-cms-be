import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewSlaCredit,
  type SlaCredit,
  slaCredits,
} from '../../infrastructure/database/schema/sla-credits.schema';
import type { SlaCreditSummary } from './dto/sla-credit-response.dto';

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
   */
  async markAppliedWithInvoice(ids: string[], invoiceId: string): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.db
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
