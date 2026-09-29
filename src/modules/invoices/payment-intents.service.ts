import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { notifyBestEffort } from '../../common/notifications/notify-best-effort';
import type {
  PaymentIntent,
  PaymentIntent as PaymentIntentRow,
} from '../../infrastructure/database/schema/invoices.schema';
import { AuditRepository } from '../audit/audit.repository';
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

/** M1: deterministic non-settle conditions are returned, not thrown; callers use `reason` only for logging/response. */
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
    // R8-OBS-3: the @Public webhook bypasses @Audit, so this is the only place payment.settle_gateway is written.
    private readonly auditRepo: AuditRepository,
  ) {}

  async create(input: CreatePaymentIntentInput): Promise<PaymentIntentResponse> {
    const invoice = await this.invoices.findById(input.invoiceId);
    if (invoice.status === 'paid') {
      throw new ConflictException('invoice already paid');
    }
    // C4: charge `balanceDue` (net of SLA discount and partial payments), the figure pay() settles.
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
      // QRIS gets the QR string, e-wallets the checkout/deeplink URL; keeps the response shape stable.
      qrPayload: charge.qrPayload ?? charge.checkoutUrl ?? null,
      gatewayReference: charge.reference,
      expiresAt: charge.expiresAt,
    });
    this.logger.log({ intentId: row.id, channel: row.channel }, 'payment intent created');
    return toIntentResponse(row);
  }

  /**
   * Settles an intent from the dev/demo confirm endpoint; refuses lapsed intents. The real
   * webhook goes through `settleFromGateway`; both share `settleIntent` (SEC-H1).
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

    return this.settleIntent(intent);
  }

  /**
   * Settle body shared by `confirm()` and `settleFromGateway` (which must settle regardless of
   * local expiry). Private so settlement is only reachable via those two (SEC-H1). The invoice
   * payment and the intent's `paid` flip commit in one transaction via recordPayment's
   * `withinTx`; an already-paid invoice skips the hook, so it falls back to a plain markPaid.
   * Locking and idempotency: see InvoicesRepository.recordPayment.
   */
  private async settleIntent(intent: PaymentIntentRow): Promise<PaymentIntentResponse> {
    let settled: PaymentIntentRow | undefined;
    await this.invoices.pay(
      intent.invoiceId,
      { method: channelToMethod(intent.channel) },
      {
        withinTx: async (tx) => {
          settled = await this.repo.markPaidTx(tx, intent.id);
        },
      },
    );
    const paid = settled ?? (await this.repo.markPaid(intent.id));
    this.logger.log({ intentId: intent.id, invoiceId: intent.invoiceId }, 'payment intent settled');
    return toIntentResponse(paid);
  }

  /**
   * Settles an intent from a verified Tripay webhook (signature checked upstream by
   * `gateway.verifyAndParseWebhook`). The only settle path reachable by an unauthenticated
   * caller (SEC-H1).
   *
   * Checks, in order: unknown intent; already 'paid' (idempotent no-op on redelivery); callback
   * `reference` must match the stored `gatewayReference` (blocks a forged merchant_ref aimed at
   * another intent); paid amount must equal the current `balanceDue`.
   *
   * M1: the failing checks are deterministic, so they are logged as `audit: true` reconciliation
   * alerts and returned as `{ settled: false, reason }` instead of throwing; a non-2xx would make
   * Tripay retry a permanent condition forever. Transient failures (e.g. DB errors) propagate so
   * a retry happens.
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

    // Gateway PAID is authoritative, so settle even if the intent lapsed locally (near-deadline
    // payment, or expireStale ran first). Going through confirm() would throw on its expiry guard,
    // drop a real payment and cause the retry storm M1 prevents. Idempotency and locking: see
    // InvoicesRepository.recordPayment. Late settlement is logged for reconciliation but is a success.
    if (intent.status === 'expired' || intent.expiresAt.getTime() <= Date.now()) {
      this.logger.warn(
        { audit: true, intentId: intent.id, reference: parsed.reference },
        'tripay webhook: settling a locally-expired intent — gateway confirms payment (late settlement); invoice credited',
      );
    }
    await this.settleIntent(intent);
    // R8-OBS-3: best-effort — a failed audit insert must never roll back or 5xx a settlement
    // that already moved money (ADR-0012).
    await notifyBestEffort(
      this.logger,
      () =>
        this.auditRepo.record({
          actor: 'tripay-webhook',
          action: 'payment.settle_gateway',
          entity: 'invoice',
          entityId: intent.invoiceId,
          summary: `payment.settle_gateway success intentId=${intent.id} reference=${parsed.reference} amount=${parsed.amount}`,
        }),
      { intentId: intent.id, invoiceId: intent.invoiceId, reference: parsed.reference },
      'audit persist failed (payment.settle_gateway)',
    );
    return { settled: true };
  }

  /**
   * L3: housekeeping for a verified non-paid Tripay callback ('expired' | 'failed'). Expires the
   * intent now so it leaves `pendingForCustomer`; Tripay 'failed' maps to 'expired' because the
   * enum has no failed value. Never touches the invoice or money path. No-op for unknown or
   * non-pending intents, so redelivery is safe.
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
   * Email/phone for Tripay's create-transaction. Degrades to name-only if the customer row is
   * missing (the simulation gateway ignores it).
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

  // --- Portal (customer-scoped) variants ---
  // Ownership misses 404 (not 403) so a caller cannot tell "not yours" from "does not exist".

  async createForCustomer(
    customerId: string,
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntentResponse> {
    const invoice = await this.invoices.findById(input.invoiceId);
    if (invoice.customerId !== customerId) throw new NotFoundException('invoice not found');
    return this.create(input);
  }

  /**
   * Read-only status poll; never flips state, so a customer has no self-settle path (SEC-H1).
   * Ownership misses 404, not 403.
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

  /** Pending, unexpired intents for the portal `/me` payload ("resume payment"). */
  async pendingForCustomer(customerId: string): Promise<PaymentIntentResponse[]> {
    const rows = await this.repo.listPendingByCustomer(customerId);
    return rows.map(toIntentResponse);
  }

  /** Hourly sweep: bulk-expires abandoned `pending` intents that never reach confirm(). */
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
