import { Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import {
  type Invoice,
  type NewInvoice,
  type NewPayment,
  type Payment,
  invoices,
  payments,
} from '../../infrastructure/database/schema/invoices.schema';

export interface InvoiceListFilter {
  status?: Invoice['status'];
  limit: number;
  offset: number;
}

export interface PaymentListFilter {
  limit: number;
  offset: number;
}

// Statuses that still owe money — used for the outstanding total.
const UNPAID_STATUSES = ['pending', 'overdue'] as const;

/**
 * The only place that talks to the `invoices` and `payments` tables.
 * Returns domain rows — never Drizzle tuples or raw SQL (Pilar 3).
 */
@Injectable()
export class InvoicesRepository {
  constructor(private readonly drizzle: DrizzleService) {}

  private get db() {
    return this.drizzle.db;
  }

  async list(filter: InvoiceListFilter): Promise<{ items: Invoice[]; total: number }> {
    const where = filter.status ? eq(invoices.status, filter.status) : undefined;
    const items = await this.db
      .select()
      .from(invoices)
      .where(where)
      .orderBy(desc(invoices.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(invoices).where(where);
    return { items, total: totals?.value ?? 0 };
  }

  async findById(id: string): Promise<Invoice | null> {
    const [row] = await this.db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    return row ?? null;
  }

  async create(input: NewInvoice): Promise<Invoice> {
    const [row] = await this.db.insert(invoices).values(input).returning();
    if (!row) {
      throw new Error('invoices.insert returned no row');
    }
    return row;
  }

  // True if the customer already has an invoice for this period — the
  // unique index guarantees it, this lets a billing run skip cleanly.
  async existsForPeriod(customerId: string, periodStart: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.customerId, customerId), eq(invoices.periodStart, periodStart)))
      .limit(1);
    return Boolean(row);
  }

  async markPaid(id: string): Promise<Invoice> {
    const [row] = await this.db
      .update(invoices)
      .set({ status: 'paid', paidAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(invoices.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('invoice not found');
    }
    return row;
  }

  /** Sum of unpaid invoice totals (amount + lateFee + taxAmount). */
  async sumUnpaidByCustomer(customerId: string): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount}), 0)`,
      })
      .from(invoices)
      .where(
        and(eq(invoices.customerId, customerId), inArray(invoices.status, [...UNPAID_STATUSES])),
      );
    return Number(row?.total ?? 0);
  }

  async countOverdueByCustomer(customerId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(invoices)
      .where(and(eq(invoices.customerId, customerId), eq(invoices.status, 'overdue')));
    return row?.value ?? 0;
  }

  // --- Payments ledger ------------------------------------------------

  async listPayments(filter: PaymentListFilter): Promise<{ items: Payment[]; total: number }> {
    const items = await this.db
      .select()
      .from(payments)
      .orderBy(desc(payments.paidAt))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totals] = await this.db.select({ value: count() }).from(payments);
    return { items, total: totals?.value ?? 0 };
  }

  async createPayment(input: NewPayment): Promise<Payment> {
    const [row] = await this.db.insert(payments).values(input).returning();
    if (!row) {
      throw new Error('payments.insert returned no row');
    }
    return row;
  }
}
