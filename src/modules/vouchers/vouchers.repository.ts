import { Injectable, NotFoundException } from '@nestjs/common';
import { count, desc, eq, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewVoucher,
  type Voucher,
  vouchers,
} from '../../infrastructure/database/schema/vouchers.schema';

export interface VoucherListFilter {
  status?: Voucher['status'];
  limit: number;
  offset: number;
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

  async list(filter: VoucherListFilter): Promise<{ items: Voucher[]; total: number }> {
    const where = filter.status ? eq(vouchers.status, filter.status) : undefined;
    const items = await this.db
      .select()
      .from(vouchers)
      .where(where)
      .orderBy(desc(vouchers.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(vouchers).where(where);
    return { items, total: totals?.value ?? 0 };
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
