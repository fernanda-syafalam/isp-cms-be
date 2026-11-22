import { Injectable } from '@nestjs/common';
import { and, desc, eq, getTableColumns, gt, lt, ne, sql } from 'drizzle-orm';
import { type Db, DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type NewPaymentIntent,
  type PaymentIntent,
  invoices,
  paymentIntents,
} from '../../infrastructure/database/schema/invoices.schema';
import type { DbTx } from './invoices.repository';

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

  /**
   * Still-resumable intents for one customer (P3.C.3): pending and not yet
   * expired. Ownership is enforced by joining through `invoices` — there is
   * no `customer_id` column on `payment_intents` — so a caller can never see
   * another customer's charge.
   */
  async listPendingByCustomer(customerId: string): Promise<PaymentIntent[]> {
    return this.db
      .select(getTableColumns(paymentIntents))
      .from(paymentIntents)
      .innerJoin(invoices, eq(invoices.id, paymentIntents.invoiceId))
      .where(
        and(
          eq(invoices.customerId, customerId),
          eq(paymentIntents.status, 'pending'),
          gt(paymentIntents.expiresAt, sql`now()`),
        ),
      )
      .orderBy(desc(paymentIntents.createdAt));
  }

  /**
   * Atomically flips a non-paid intent to paid; null when it was already paid (another delivery
   * won). The single claim point for settlement, so a token can only be spent once.
   */
  async claimPaid(id: string): Promise<PaymentIntent | null> {
    return this.claimPaidTx(this.db, id);
  }

  async claimPaidTx(tx: Db | DbTx, id: string): Promise<PaymentIntent | null> {
    const [row] = await tx
      .update(paymentIntents)
      .set({ status: 'paid', paidAt: sql`now()` })
      .where(and(eq(paymentIntents.id, id), ne(paymentIntents.status, 'paid')))
      .returning();
    return row ?? null;
  }

  async markExpired(id: string): Promise<void> {
    await this.db
      .update(paymentIntents)
      .set({ status: 'expired' })
      .where(and(eq(paymentIntents.id, id), eq(paymentIntents.status, 'pending')));
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
