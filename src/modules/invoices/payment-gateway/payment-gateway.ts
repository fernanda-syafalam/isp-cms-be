import type { PaymentIntent } from '../../../infrastructure/database/schema/invoices.schema';

/** Payment rail, reusing the same enum the intent itself is keyed on. */
export type PaymentChannel = PaymentIntent['channel'];

/** Contact details the gateway needs to open a charge (Tripay requires them). */
export type ChargeCustomer = {
  name: string;
  email?: string;
  phone?: string;
};

export type CreateChargeInput = {
  invoiceId: string;
  invoiceNo: string;
  /**
   * OUR reference, generated before the intent row is inserted (P0.4 note:
   * `PaymentIntentsService.create` mints this id up front and reuses it as
   * both the intent's primary key and the gateway's `merchant_ref`). The
   * webhook resolves back to an intent by this value alone — never by
   * trusting the gateway's own `reference` for lookup.
   */
  merchantRef: string;
  amount: number;
  channel: PaymentChannel;
  customer: ChargeCustomer;
};

export type CreateChargeResult = {
  /** The gateway's own transaction id (Tripay `reference`). Stored for
   *  reconciliation/audit only — never the lookup key (see `merchantRef`). */
  reference: string;
  /** VA number, set for `va_*` channels. */
  payCode?: string;
  /** QR string (`qris`) or checkout/deeplink URL (e-wallet channels). */
  qrPayload?: string;
  checkoutUrl?: string;
  expiresAt: Date;
};

export type WebhookSettlementStatus = 'paid' | 'expired' | 'failed';

export type WebhookVerifyResult = {
  /** The gateway's own transaction id (Tripay `reference`). */
  reference: string;
  /** OUR reference, echoed back by the gateway (Tripay `merchant_ref`) —
   *  this is what resolves the callback to a `payment_intents` row. */
  invoiceRef: string;
  status: WebhookSettlementStatus;
  amount: number;
};

/**
 * Payment-gateway seam (ADR-0016), mirroring the `RouterAdapter` pattern in
 * `router-resources/adapters/`: an abstract class (not a bare interface) so
 * it doubles as a Nest DI token, selected by `PAYMENT_MODE` in
 * `invoices.module.ts` exactly like `ROUTEROS_MODE` selects `RouterAdapter`.
 *
 * `SimulationPaymentGateway` (default) reproduces the existing dev/demo
 * mock byte-for-byte. `TripayPaymentGateway` (`PAYMENT_MODE=live`) is the
 * only implementation that moves real money or authenticates a webhook
 * caller — see that class's doc comment for the security model.
 */
export abstract class PaymentGateway {
  /** Open a charge for one invoice. Throws on a gateway/network failure —
   *  the caller (`PaymentIntentsService.create`) must not persist a
   *  `payment_intents` row for a charge the gateway never actually opened. */
  abstract createCharge(input: CreateChargeInput): Promise<CreateChargeResult>;

  /**
   * Verify + parse an inbound settlement callback. MUST authenticate the
   * caller by signature before returning anything derived from the body —
   * this is the ONLY authentication a webhook route has (it is `@Public()`,
   * no JWT). Throws `UnauthorizedException` (not a generic `Error`) on a
   * missing/invalid signature so the controller's failure mode is an
   * explicit 401, never a 500 that could look like a transient retry-me.
   */
  abstract verifyAndParseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): WebhookVerifyResult;
}
