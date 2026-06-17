import { Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, ilike, or, sql, sum } from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewVoucher,
  type Voucher,
  vouchers,
} from '../../infrastructure/database/schema/vouchers.schema';

// Columns the frontend may sort on (camelCase key → Drizzle column).
// Unknown/absent key falls back to `createdAt desc` via buildOrderBy — never throws.
const VOUCHERS_SORT_WHITELIST = {
  code: vouchers.code,
  profile: vouchers.profile,
  priceIdr: vouchers.priceIdr,
  durationDays: vouchers.durationDays,
  status: vouchers.status,
  createdAt: vouchers.createdAt,
} satisfies Record<string, (typeof vouchers)[keyof typeof vouchers]>;

export interface VoucherListFilter {
  status?: Voucher['status'];
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface VoucherSummary {
  total: number;
  unused: number;
  used: number;
  revenue: number;
}

/**
 * The only place that talks to the `vouchers` table. Returns domain rows —
 * never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class VouchersRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async list(
    filter: VoucherListFilter,
  ): Promise<{ items: Voucher[]; total: number; summary: VoucherSummary }> {
    // Build the WHERE clause for status + q (used for items + filtered total).
    const where = and(
      filter.status ? eq(vouchers.status, filter.status) : undefined,
      filter.q
        ? or(ilike(vouchers.code, `%${filter.q}%`), ilike(vouchers.profile, `%${filter.q}%`))
        : undefined,
    );

    const orderBy = buildOrderBy(
      filter.sort,
      filter.order,
      VOUCHERS_SORT_WHITELIST,
      desc(vouchers.createdAt),
    );

    const items = await this.db
      .select()
      .from(vouchers)
      .where(where)
      .orderBy(orderBy)
      .limit(filter.limit)
      .offset(filter.offset);

    const [filteredCount] = await this.db.select({ value: count() }).from(vouchers).where(where);

    // Full-set summary — computed over ALL vouchers, ignoring status/q/paging.
    const [summaryRow] = await this.db
      .select({
        total: count(),
        unused: sql<number>`count(*) filter (where ${vouchers.status} = 'unused')`,
        used: sql<number>`count(*) filter (where ${vouchers.status} = 'used')`,
        revenue: sum(
          sql`case when ${vouchers.status} = 'used' then ${vouchers.priceIdr} else 0 end`,
        ),
      })
      .from(vouchers);

    const summary: VoucherSummary = {
      total: summaryRow?.total ?? 0,
      unused: Number(summaryRow?.unused ?? 0),
      used: Number(summaryRow?.used ?? 0),
      revenue: Number(summaryRow?.revenue ?? 0),
    };

    return { items, total: filteredCount?.value ?? 0, summary };
  }

  async findById(id: string): Promise<Voucher | null> {
    const [row] = await this.db.select().from(vouchers).where(eq(vouchers.id, id)).limit(1);
    return row ?? null;
  }

  // Bulk insert one minted batch; returns how many rows landed.
  async createBatch(rows: NewVoucher[]): Promise<number> {
    if (rows.length === 0) return 0;
    const inserted = await this.db.insert(vouchers).values(rows).returning({ id: vouchers.id });
    return inserted.length;
  }

  /**
   * Mark a voucher redeemed. usedBy defaults to "Admin (manual)" only when
   * not already set, so a hotspot-supplied identifier is preserved.
   */
  async redeem(id: string): Promise<Voucher> {
    const [row] = await this.db
      .update(vouchers)
      .set({
        status: 'used',
        usedAt: sql`now()`,
        usedBy: sql`coalesce(${vouchers.usedBy}, 'Admin (manual)')`,
        updatedAt: sql`now()`,
      })
      .where(eq(vouchers.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('voucher not found');
    }
    return row;
  }
}
