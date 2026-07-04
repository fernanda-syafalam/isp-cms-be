import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewPaymentIntent,
  type PaymentIntent,
  paymentIntents,
} from '../../infrastructure/database/schema/invoices.schema';

/**
 * The only place that talks to the `payment_intents` table. Returns domain
 * rows (Pilar 3).
 */
@Injectable()
export class PaymentIntentsRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async create(values: NewPaymentIntent): Promise<PaymentIntent> {
    const [row] = await this.db.insert(paymentIntents).values(values).returning();
    if (!row) {
      throw new Error('payment intent row missing after insert');
    }
    return row;
  }

  async findById(id: string): Promise<PaymentIntent | null> {
    const [row] = await this.db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, id))
      .limit(1);
    return row ?? null;
  }

  async markPaid(id: string): Promise<PaymentIntent> {
    const [row] = await this.db
      .update(paymentIntents)
      .set({ status: 'paid', paidAt: sql`now()` })
      .where(eq(paymentIntents.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('payment intent not found');
    }
    return row;
  }

  async markExpired(id: string): Promise<void> {
    await this.db
      .update(paymentIntents)
      .set({ status: 'expired' })
      .where(eq(paymentIntents.id, id));
  }

  /**
   * Expire every still-`pending` intent whose window has closed. Used by the
   * hourly expire-sweep (P2.1) — without it stale intents pile up forever.
   * Returns the number of rows expired.
   */
  async expireStalePending(now: Date): Promise<number> {
    const result = await this.db
      .update(paymentIntents)
      .set({ status: 'expired' })
      .where(and(eq(paymentIntents.status, 'pending'), lt(paymentIntents.expiresAt, now)));
    return result.rowCount ?? 0;
  }
}
