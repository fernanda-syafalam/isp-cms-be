import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  PaymentIntent,
  PaymentIntent as PaymentIntentRow,
} from '../../infrastructure/database/schema/invoices.schema';
import { CustomersRepository } from '../customers/customers.repository';
import type { CreatePaymentIntentInput } from './dto/create-payment-intent.dto';
import type { InvoiceResponse } from './dto/invoice-response.dto';
import type { PaymentIntentResponse } from './dto/payment-intent-response.dto';
import type { RecordPaymentInput } from './dto/record-payment.dto';
import { InvoicesService } from './invoices.service';
import { PaymentGateway } from './payment-gateway/payment-gateway';
import { PaymentIntentsRepository } from './payment-intents.repository';

type Channel = PaymentIntent['channel'];

const VA_CHANNELS = new Set<Channel>(['va_bca', 'va_mandiri', 'va_bri', 'va_bni']);

/**
 * M1: `settleFromGateway`'s result never throws for a DETERMINISTIC
 * non-settle condition (see that method's doc comment) — the caller
 * (`TripayWebhookController`) inspects `reason` only to decide what to log
 * / how to respond; the actual reconciliation-alert logging already
 * happened inside `settleFromGateway`.
 */
export type SettleFromGatewayResult =
  | { settled: true }
  | { settled: false; reason: 'unknown_intent' | 'reference_mismatch' | 'amount_mismatch' };

@Injectable()
export class PaymentIntentsService {
  private readonly logger = new Logger(PaymentIntentsService.name);

  constructor(
    private readonly repo: PaymentIntentsRepository,
    // Intents settle real invoices, so they go through the billing service
    // (mark paid + ledger entry + customer reactivation).
    private readonly invoices: InvoicesService,
    // ADR-0016: opens the actual charge (mock VA/QR in simulation, a real
    // Tripay transaction in live mode) — selected by PAYMENT_MODE in
    // invoices.module.ts, same DI-token-selection pattern as RouterAdapter.
    private readonly gateway: PaymentGateway,
    // Tripay's create-transaction call needs the customer's contact details
    // (email/phone) — `invoices` only carries the denormalized name.
    private readonly customers: CustomersRepository,
  ) {}

  async create(input: CreatePaymentIntentInput): Promise<PaymentIntentResponse> {
    const invoice = await this.invoices.findById(input.invoiceId);
    if (invoice.status === 'paid') {
      throw new ConflictException('invoice already paid');
    }
    // C4: charge exactly what's still owed. `balanceDue` already nets out
    // discountAmount (SLA credit) and any prior partial payment — the same
    // derived field `pay()` settles against — so the VA/QR amount can never
    // overstate what a real gateway settlement would actually credit.
    if (invoice.balanceDue <= 0) {
      throw new ConflictException('invoice has no balance due');
    }

    const amount = invoice.balanceDue;
    const { channel } = input;
    // Minted up front (not left to the DB default) so it can double as the
    // gateway's merchant_ref — the webhook resolves back to this exact row
    // by this id, never by trusting the gateway's own reference for lookup.
    const id = randomUUID();
    const charge = await this.gateway.createCharge({
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      merchantRef: id,
      amount,
      channel,
      customer: await this.resolveChargeCustomer(invoice),
    });

    const row = await this.repo.create({
      id,
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      customerName: invoice.customerName,
      amount,
      channel,
      status: 'pending',
      vaNumber: charge.payCode ?? null,
      // Channel payload is deliberately generic: QRIS gets the QR string,
      // e-wallet channels get the checkout/deeplink URL — same field the
      // simulation mock already overloaded this way (isVaChannel ? va :
      // payload), so the response shape never changes.
      qrPayload: charge.qrPayload ?? charge.checkoutUrl ?? null,
      gatewayReference: charge.reference,
      expiresAt: charge.expiresAt,
    });
    this.logger.log({ intentId: row.id, channel: row.channel }, 'payment intent created');
    return toIntentResponse(row);
  }

  /**
   * Settle an intent. Called from two places: the dev/demo "confirm"
   * endpoint (`POST /v1/payments/intent/:id/confirm`, simulates the gateway
   * webhook) and `settleFromGateway` below (the REAL Tripay webhook, once
   * it has already verified the signature + amount). Reuses the same
   * transactional settle path (`invoices.pay`) either way — settlement
   * logic itself is never duplicated (SEC-H1).
   */
  async confirm(id: string): Promise<PaymentIntentResponse> {
    const intent = await this.repo.findById(id);
    if (!intent) throw new NotFoundException('payment intent not found');
    if (intent.status === 'paid') {
      return toIntentResponse(intent); // idempotent — webhook may retry
    }
    if (intent.status === 'expired' || intent.expiresAt.getTime() <= Date.now()) {
      if (intent.status !== 'expired') await this.repo.markExpired(id);
      throw new ConflictException('payment intent expired');
    }

    await this.invoices.pay(intent.invoiceId, { method: channelToMethod(intent.channel) });
    const paid = await this.repo.markPaid(id);
    this.logger.log({ intentId: id, invoiceId: intent.invoiceId }, 'payment intent settled');
    return toIntentResponse(paid);
  }

  /**
   * Settle an intent from a VERIFIED Tripay webhook callback
   * (`TripayWebhookController` — signature already checked by
   * `gateway.verifyAndParseWebhook` before this is ever called). This is
   * the only settlement path reachable from an unauthenticated HTTP caller
   * (SEC-H1: a customer/anonymous caller can never call `confirm()`
   * directly — see `findForCustomer`'s doc comment).
   *
   * - Idempotent by intent id (== Tripay's `merchant_ref` /
   *   `parsed.invoiceRef`): a redelivered callback for an already-'paid'
   *   intent is a no-op, same short-circuit `confirm()` already has — one
   *   Tripay `reference` maps 1:1 to one intent for its whole lifecycle, so
   *   this also satisfies "dedupe by gateway reference".
   * - Defense in depth: if this intent already recorded a
   *   `gatewayReference` (set at charge-create time), the callback's
   *   `reference` must match it — a forged `merchant_ref` pointing at
   *   someone else's intent id must not settle it just because the
   *   signature on the (attacker-controlled-content, gateway-signed)
   *   envelope is otherwise valid.
   * - Amount check: the callback's paid amount must equal the invoice's
   *   CURRENT `balanceDue` — never trust the gateway to have charged the
   *   right amount, and never settle a mismatched one.
   *
   * M1: the three checks above are DETERMINISTIC non-settle conditions —
   * retrying the exact same callback can never make them succeed (an
   * unknown intent stays unknown, a forged/stale reference stays wrong,
   * and a stale amount stays stale until a human looks at it). Callers
   * MUST NOT translate these into a non-2xx HTTP response: Tripay retries
   * a failed webhook delivery, and retrying a permanent condition forever
   * is a retry storm that helps nobody. Each case is instead logged as an
   * `audit: true` reconciliation alert and returned as `{ settled: false,
   * reason }` — refusing to settle is still the correct MONEY decision
   * (never paper over a mismatch), only the HTTP-level "should the caller
   * retry" signal changes. A genuinely transient failure (e.g. the DB call
   * itself throwing) is NOT caught here and propagates normally — THAT is
   * when a non-2xx / retry is actually the right behavior.
   */
  async settleFromGateway(parsed: {
    reference: string;
    invoiceRef: string;
    amount: number;
  }): Promise<SettleFromGatewayResult> {
    const intent = await this.repo.findById(parsed.invoiceRef);
    if (!intent) {
      this.logger.warn(
        { audit: true, reference: parsed.reference, invoiceRef: parsed.invoiceRef },
        'tripay webhook: unknown payment intent — acknowledging without settling; reconcile manually if this represents a real payment',
      );
      return { settled: false, reason: 'unknown_intent' };
    }

    if (intent.status === 'paid') {
      this.logger.log(
        { intentId: intent.id, reference: parsed.reference },
        'tripay webhook: intent already settled — idempotent no-op',
      );
      return { settled: true };
    }

    if (intent.gatewayReference && intent.gatewayReference !== parsed.reference) {
      this.logger.error(
        {
          audit: true,
          intentId: intent.id,
          expected: intent.gatewayReference,
          received: parsed.reference,
        },
        'tripay webhook: gateway reference mismatch — acknowledging without settling; reconcile manually',
      );
      return { settled: false, reason: 'reference_mismatch' };
    }

    const invoice = await this.invoices.findById(intent.invoiceId);
    if (invoice.balanceDue !== parsed.amount) {
      this.logger.error(
        {
          audit: true,
          intentId: intent.id,
          invoiceId: invoice.id,
          expected: invoice.balanceDue,
          received: parsed.amount,
        },
        'tripay webhook: amount mismatch — acknowledging without settling; reconcile manually (e.g. balanceDue moved via another channel since the charge was created, or this is a bad/forged callback)',
      );
      return { settled: false, reason: 'amount_mismatch' };
    }

    await this.confirm(intent.id);
    return { settled: true };
  }

  /**
   * L3: housekeeping for a VERIFIED Tripay callback whose status is NOT
   * 'paid' ('expired' or 'failed') — before this, `TripayWebhookController`
   * treated the whole non-paid branch as a pure no-op, leaving the intent
   * `pending` until the hourly `expireStale` sweep caught up. This marks it
   * `expired` immediately so it stops appearing in `pendingForCustomer`
   * ("resume payment") right away. `payment_intents.status` has no distinct
   * `failed` value (`payment_intent_status` enum is only pending/paid/
   * expired) — Tripay's `failed` and `expired` are both mapped to the same
   * `expired` intent status, since both mean the same thing from this
   * table's point of view: this charge is dead, stop offering it.
   *
   * Deliberately does NOT touch the invoice or any money path (no ledger
   * row, no balance change) — an intent going stale/failed says nothing
   * about the invoice itself, which stays payable via a fresh intent or any
   * other channel. No-op (not an error) for an unknown intent or one that
   * is already `paid`/`expired` — idempotent for a redelivered callback.
   */
  async markGatewayNonSettlement(invoiceRef: string): Promise<void> {
    const intent = await this.repo.findById(invoiceRef);
    if (!intent || intent.status !== 'pending') return;
    await this.repo.markExpired(intent.id);
    this.logger.log(
      { intentId: intent.id },
      'tripay webhook: non-paid callback — marked intent expired',
    );
  }

  /**
   * Contact details Tripay's create-transaction call requires. The invoice
   * only carries a denormalized `customerName` — this resolves the actual
   * customer row for `email`/`phone`. Missing/unknown customer (should not
   * happen for a real invoice) degrades to name-only rather than blocking
   * the charge — the simulation gateway ignores this input entirely, so
   * only the live path is actually affected.
   */
  private async resolveChargeCustomer(
    invoice: InvoiceResponse,
  ): Promise<{ name: string; email?: string; phone?: string }> {
    const customer = await this.customers.findById(invoice.customerId);
    return {
      name: invoice.customerName,
      email: customer?.email ?? undefined,
      phone: customer?.phone ?? undefined,
    };
  }

  // --- Portal (customer-scoped) variants --------------------------------
  // Staff act on anyone via the /v1/payments routes; a customer acts only
  // on their own invoices. Ownership misses 404 (not 403) so a probing
  // caller cannot distinguish "not yours" from "does not exist".

  async createForCustomer(
    customerId: string,
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntentResponse> {
    const invoice = await this.invoices.findById(input.invoiceId);
    if (invoice.customerId !== customerId) throw new NotFoundException('invoice not found');
    return this.create(input);
  }

  /**
   * Read-only status poll for the customer's own intent (SEC-H1 interim
   * fix). Settlement is no longer reachable from the customer at all — it
   * only happens via `confirm()` above, called from the staff/admin route
   * or (P4, future) a signed gateway webhook. This never flips state, so
   * there is no self-settle path hiding behind "just checking status".
   * Ownership misses 404 (not 403), same posture as the other portal
   * IDOR guards.
   */
  async findForCustomer(customerId: string, id: string): Promise<PaymentIntentResponse> {
    const intent = await this.repo.findById(id);
    if (!intent) throw new NotFoundException('payment intent not found');
    const invoice = await this.invoices.findById(intent.invoiceId);
    if (invoice.customerId !== customerId) {
      throw new NotFoundException('payment intent not found');
    }
    return toIntentResponse(intent);
  }

  /**
   * Still-resumable intents (pending, not expired) for one customer (P3.C.3)
   * — feeds the portal `/me` payload so the FE can offer "resume payment"
   * instead of discarding an in-flight intent on dialog close.
   */
  async pendingForCustomer(customerId: string): Promise<PaymentIntentResponse[]> {
    const rows = await this.repo.listPendingByCustomer(customerId);
    return rows.map(toIntentResponse);
  }

  /**
   * Expire every stale `pending` intent in one sweep (P2.1 hourly job). The
   * per-intent expiry check in confirm() only fires when someone confirms;
   * abandoned intents never get there, so this bulk-expires them.
   */
  async expireStale(): Promise<{ expired: number }> {
    const expired = await this.repo.expireStalePending(new Date());
    if (expired > 0) this.logger.log({ expired }, 'expired stale payment intents');
    return { expired };
  }
}

function channelToMethod(channel: Channel): RecordPaymentInput['method'] {
  if (channel === 'qris') return 'qris';
  if (VA_CHANNELS.has(channel)) return 'va';
  return 'ewallet'; // gopay / ovo / dana / shopeepay
}

function toIntentResponse(row: PaymentIntentRow): PaymentIntentResponse {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    invoiceNo: row.invoiceNo,
    customerName: row.customerName,
    amount: row.amount,
    channel: row.channel,
    status: row.status,
    vaNumber: row.vaNumber,
    qrPayload: row.qrPayload,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
  };
}
