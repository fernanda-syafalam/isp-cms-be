import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  or,
  sql,
  sum,
} from 'drizzle-orm';
import { buildOrderBy } from '../../common/utils/list-sort';
import { type Db, DrizzleService } from '../../infrastructure/database/drizzle.service';
import { customers } from '../../infrastructure/database/schema/customers.schema';
import { invoices, payments } from '../../infrastructure/database/schema/invoices.schema';
import { resellerLedger, resellers } from '../../infrastructure/database/schema/resellers.schema';
import {
  type NewVoucher,
  type Voucher,
  vouchers,
} from '../../infrastructure/database/schema/vouchers.schema';

// The transaction handle drizzle hands its callback — used to type the
// private write helper without an `any`.
type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Statuses that still owe money — mirrors InvoicesRepository's own
// UNPAID_STATUSES (P3.A.4). 'partial' counts as unpaid too.
const UNPAID_STATUSES = ['pending', 'partial', 'overdue'] as const;

// A voucher row joined with its attributed mitra's name. resellerName is
// never stored on the voucher (single source of truth lives in resellers);
// null when the voucher has no attributed reseller.
export type VoucherRow = Voucher & { resellerName: string | null };

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
  expired: number;
  revenue: number;
}

// Input to the transactional settlement (P3.D.3) — see `settle()`.
export interface SettleVoucherInput {
  // Subscriber the voucher was sold to (loket sale) — resolved by the
  // service. Null/absent for an anonymous hotspot redemption.
  redeemedCustomerId?: string | null;
  usedBy?: string | null;
  // Overrides the voucher's minted-batch reseller for this one redemption.
  // Null/absent falls back to the voucher's own `resellerId`.
  resellerId?: string | null;
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

  // Every read returns the voucher columns plus the joined reseller name.
  // resellerId is nullable, so this is a LEFT JOIN — an unattributed voucher
  // must still come back (with resellerName: null), never get dropped.
  private baseSelect() {
    return this.db
      .select({ ...getTableColumns(vouchers), resellerName: resellers.name })
      .from(vouchers)
      .leftJoin(resellers, eq(vouchers.resellerId, resellers.id));
  }

  async list(
    filter: VoucherListFilter,
  ): Promise<{ items: VoucherRow[]; total: number; summary: VoucherSummary }> {
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

    const items = await this.baseSelect()
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
        expired: sql<number>`count(*) filter (where ${vouchers.status} = 'expired')`,
        revenue: sum(
          sql`case when ${vouchers.status} = 'used' then ${vouchers.priceIdr} else 0 end`,
        ),
      })
      .from(vouchers);

    const summary: VoucherSummary = {
      total: summaryRow?.total ?? 0,
      unused: Number(summaryRow?.unused ?? 0),
      used: Number(summaryRow?.used ?? 0),
      expired: Number(summaryRow?.expired ?? 0),
      revenue: Number(summaryRow?.revenue ?? 0),
    };

    return { items, total: filteredCount?.value ?? 0, summary };
  }

  async findById(id: string): Promise<VoucherRow | null> {
    const [row] = await this.baseSelect().where(eq(vouchers.id, id)).limit(1);
    return row ?? null;
  }

  // Bulk insert one minted batch; returns how many rows landed.
  async createBatch(rows: NewVoucher[]): Promise<number> {
    if (rows.length === 0) return 0;
    const inserted = await this.db.insert(vouchers).values(rows).returning({ id: vouchers.id });
    return inserted.length;
  }

  /**
   * Redeem a voucher — the full loket settlement, in ONE DB transaction
   * (P3.D.3, ADR-0010). This is money code: the voucher flip, the payment
   * ledger row, the customer's AR allocation and the reseller commission
   * either all land together or none do.
   *
   * Steps, all inside `tx`:
   *  1. `SELECT ... FOR UPDATE` the voucher — locks the row so a concurrent
   *     second settle on the same id blocks until this transaction commits,
   *     then re-reads a status that is no longer 'unused'.
   *  2. Idempotency guard: if the voucher is already `used`, return it
   *     unchanged — no new payment, no second AR allocation, no second
   *     commission. A retried/duplicated settle call is always safe.
   *     (An `expired` voucher may never be redeemed — throws 422.)
   *  3. Flip the voucher to `used` (usedAt/usedBy/redeemedCustomerId).
   *  4. If sold to a subscriber, allocate the voucher's face value across
   *     their unpaid invoices oldest-first via `allocateToInvoices` — see
   *     that method's doc for why this must NOT be a direct decrement of
   *     `customers.outstanding`.
   *  5. Insert the `payments` row: source='voucher', voucherId=id,
   *     invoiceId/invoiceNo NULL, amount = voucher.priceIdr, method='cash',
   *     tenderedAmount = priceIdr, changeAmount = 0 (a loket voucher sale is
   *     an exact-cash cash-drawer transaction, P3.A.4 — this keeps
   *     `InvoicesRepository.reconciliation()`'s cash tendered/change
   *     roll-up balanced; that query itself is untouched).
   *  6. If a reseller is attributed (override param or the voucher's own
   *     `resellerId`) and its commissionPct > 0, append a `commission`
   *     `reseller_ledger` entry keyed `ref = 'voucher:'+id` and move the
   *     reseller's balance — reusing the exact idempotency key shape from
   *     `ResellersRepository.postCommissionForInvoice` (P3.D.1). The
   *     `reseller_ledger_reseller_type_ref_idx` partial unique index is the
   *     hard backstop: even if this in-process existence check ever raced,
   *     the DB itself rejects a second (resellerId, 'commission', ref) row.
   *
   * This method is the one deliberate exception to "one repository per
   * table": it reaches into `payments` / `customers` / `invoices` /
   * `resellers` / `reseller_ledger` directly so all these writes share a
   * single transaction handle. Splitting it across repositories (as
   * invoices.pay() -> postResellerCommission does today) would mean a crash
   * between calls leaves a payment recorded but no commission posted, or
   * vice versa — unacceptable for a cash-settlement path.
   */
  async settle(id: string, opts: SettleVoucherInput = {}): Promise<Voucher> {
    return this.db.transaction(async (tx) => {
      const [voucher] = await tx
        .select()
        .from(vouchers)
        .where(eq(vouchers.id, id))
        .for('update')
        .limit(1);
      if (!voucher) {
        throw new NotFoundException('voucher not found');
      }
      if (voucher.status === 'used') {
        // Idempotent no-op — see method doc.
        return voucher;
      }
      if (voucher.status === 'expired') {
        throw new UnprocessableEntityException('Voucher sudah kedaluwarsa, tidak bisa ditukar');
      }

      const [redeemed] = await tx
        .update(vouchers)
        .set({
          status: 'used',
          usedAt: sql`now()`,
          usedBy: opts.usedBy ? opts.usedBy : sql`coalesce(${vouchers.usedBy}, 'Admin (manual)')`,
          ...(opts.redeemedCustomerId ? { redeemedCustomerId: opts.redeemedCustomerId } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(vouchers.id, id))
        .returning();
      if (!redeemed) {
        throw new NotFoundException('voucher not found');
      }

      // Loket sale to a subscriber: allocate the face value to their unpaid
      // invoices like a real payment (never a direct outstanding decrement —
      // see `allocateToInvoices`). Snapshot their name onto the payment row;
      // falls back to the usedBy label for an anonymous redemption.
      let customerName: string | null = redeemed.usedBy;
      if (opts.redeemedCustomerId) {
        const customerId = opts.redeemedCustomerId;
        const [customer] = await tx
          .select({ id: customers.id, fullName: customers.fullName })
          .from(customers)
          .where(eq(customers.id, customerId))
          .for('update')
          .limit(1);
        if (customer) {
          customerName = customer.fullName;
          await this.allocateToInvoices(tx, customerId, redeemed.priceIdr);
        }
      }

      // A voucher sale is exact cash — tenderedAmount/changeAmount are set so
      // the cash-drawer reconciliation roll-up (P3.A.4) stays balanced.
      await tx.insert(payments).values({
        source: 'voucher',
        voucherId: id,
        invoiceId: null,
        invoiceNo: null,
        customerId: opts.redeemedCustomerId ?? null,
        customerName,
        amount: redeemed.priceIdr,
        method: 'cash',
        tenderedAmount: redeemed.priceIdr,
        changeAmount: 0,
      });

      const resellerId = opts.resellerId ?? redeemed.resellerId ?? null;
      if (resellerId) {
        await this.postVoucherCommission(tx, {
          resellerId,
          voucherId: id,
          voucherCode: redeemed.code,
          amount: redeemed.priceIdr,
        });
      }

      return redeemed;
    });
  }

  /**
   * Allocate a settled voucher's face value to one customer's unpaid
   * invoices, oldest due date first — exactly like a real payment
   * (`InvoicesRepository.applyPayment`, P3.A.4), NOT a direct decrement of
   * `customers.outstanding`.
   *
   * Why: `outstanding` is a DERIVED column. `InvoicesService.
   * refreshCustomerBilling` recomputes and overwrites it from
   * `sumUnpaidByCustomer()` (a sum over `invoices`) on every subsequent
   * invoice payment / billing run. A direct decrement here would get
   * silently clobbered the next time that runs — the voucher credit would
   * vanish from the AR system-of-record and the customer would still get
   * dunned/isolir despite having paid. Allocating to `invoices.paidAmount`
   * (same balanceDue / paid-transition rules as `applyPayment`) and then
   * recomputing `outstanding` from the same `sumUnpaidByCustomer` definition
   * makes the two consistent by construction.
   *
   * `SELECT ... FOR UPDATE` locks every unpaid invoice up front so a
   * concurrent payment/settle against the same customer serializes instead
   * of both reading a stale `paidAmount`. Any voucher amount beyond what's
   * actually owed is simply left unallocated (the payment row still records
   * the full amount received — see `settle`). No-op, `outstanding`
   * untouched, when the customer has no unpaid invoices at all.
   */
  private async allocateToInvoices(tx: DbTx, customerId: string, amount: number): Promise<void> {
    const unpaid = await tx
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.customerId, customerId), inArray(invoices.status, [...UNPAID_STATUSES])),
      )
      .orderBy(asc(invoices.dueDate))
      .for('update');
    if (unpaid.length === 0) return;

    let remaining = amount;
    for (const invoice of unpaid) {
      if (remaining <= 0) break;
      const total = invoice.amount + invoice.lateFee + invoice.taxAmount - invoice.discountAmount;
      const balanceDue = total - invoice.paidAmount;
      if (balanceDue <= 0) continue; // already fully covered — skip, don't touch

      const applied = Math.min(remaining, balanceDue);
      const paidAmount = invoice.paidAmount + applied;
      const paidInFull = paidAmount >= total;
      await tx
        .update(invoices)
        .set({
          paidAmount,
          status: paidInFull ? 'paid' : 'partial',
          paidAt: paidInFull ? sql`now()` : invoice.paidAt,
          updatedAt: sql`now()`,
        })
        .where(eq(invoices.id, invoice.id));
      remaining -= applied;
    }

    // Recompute outstanding from the invoices we just updated — the exact
    // same expression as InvoicesRepository.sumUnpaidByCustomer, so the two
    // never drift.
    const [sumRow] = await tx
      .select({
        total: sql<string>`coalesce(sum(${invoices.amount} + ${invoices.lateFee} + ${invoices.taxAmount} - ${invoices.discountAmount} - ${invoices.paidAmount}), 0)`,
      })
      .from(invoices)
      .where(
        and(eq(invoices.customerId, customerId), inArray(invoices.status, [...UNPAID_STATUSES])),
      );

    await tx
      .update(customers)
      .set({ outstanding: Number(sumRow?.total ?? 0), updatedAt: sql`now()` })
      .where(eq(customers.id, customerId));
  }

  /**
   * Append the commission entry for a settled voucher, idempotently — the
   * same (resellerId, 'commission', ref) shape as
   * `ResellersRepository.postCommissionForInvoice` (P3.D.1), just keyed
   * `ref = 'voucher:'+voucherId` instead of an invoice id. No-op when the
   * reseller is unknown, inactive-rate (commissionPct <= 0), the rounded
   * commission is zero, or a commission for this voucher already exists.
   */
  private async postVoucherCommission(
    tx: DbTx,
    input: { resellerId: string; voucherId: string; voucherCode: string; amount: number },
  ): Promise<void> {
    const ref = `voucher:${input.voucherId}`;

    const [existing] = await tx
      .select({ id: resellerLedger.id })
      .from(resellerLedger)
      .where(
        and(
          eq(resellerLedger.resellerId, input.resellerId),
          eq(resellerLedger.type, 'commission'),
          eq(resellerLedger.ref, ref),
        ),
      )
      .limit(1);
    if (existing) return; // already posted — never double-credit a retry.

    const [reseller] = await tx
      .select()
      .from(resellers)
      .where(eq(resellers.id, input.resellerId))
      .for('update')
      .limit(1);
    if (!reseller || reseller.commissionPct <= 0) return;

    const commission = Math.round(input.amount * reseller.commissionPct);
    if (commission <= 0) return;

    const nextBalance = reseller.balance + commission;
    await tx.insert(resellerLedger).values({
      resellerId: input.resellerId,
      type: 'commission',
      amount: commission,
      note: `Komisi voucher ${input.voucherCode}`,
      balanceAfter: nextBalance,
      ref,
    });
    await tx
      .update(resellers)
      .set({ balance: nextBalance, updatedAt: sql`now()` })
      .where(eq(resellers.id, input.resellerId));
  }
}
