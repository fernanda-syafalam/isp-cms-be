import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration';
import {
  type CreateChargeInput,
  type CreateChargeResult,
  type PaymentChannel,
  PaymentGateway,
  type WebhookSettlementStatus,
  type WebhookVerifyResult,
} from './payment-gateway';

const CALLBACK_SIGNATURE_HEADER = 'x-callback-signature';

/**
 * Our `PaymentChannel` → Tripay's closed-payment `method` code. ASSUMPTION
 * (PR review item): copied from Tripay's publicly documented channel list
 * at implementation time, NOT verified against a live merchant dashboard —
 * confirm every code here against the actual enabled-channel list before
 * flipping `PAYMENT_MODE=live` in any real environment. A channel with no
 * confirmed Tripay code intentionally has none mapped, so `createCharge`
 * fails loudly (not silently mischarges the wrong rail) instead of guessing.
 */
const TRIPAY_METHOD: Partial<Record<PaymentChannel, string>> = {
  va_bca: 'BCAVA',
  va_mandiri: 'MANDIRIVA',
  va_bri: 'BRIVA',
  va_bni: 'BNIVA',
  qris: 'QRIS2',
  dana: 'DANA',
  shopeepay: 'SPAY',
  // 'ovo' and 'gopay': no confirmed Tripay closed-payment code at
  // implementation time (Tripay's e-wallet channel list has moved between
  // OVO/QRIS-only aggregation over time) — left unmapped on purpose.
};

/** Tripay's callback `status` values we handle. Unrecognized -> 'failed'
 *  (fail-closed: never assume an unknown status means paid). */
function toSettlementStatus(status: string): WebhookSettlementStatus {
  if (status === 'PAID') return 'paid';
  if (status === 'EXPIRED') return 'expired';
  return 'failed';
}

type TripayCreateResponse = {
  success: boolean;
  message?: string;
  data?: {
    reference: string;
    pay_code?: string | null;
    qr_string?: string | null;
    qr_url?: string | null;
    checkout_url?: string | null;
    expired_time: number; // unix seconds
  };
};

type TripayCallbackBody = {
  reference: string;
  merchant_ref: string;
  status: string;
  total_amount: number;
};

/**
 * Live gateway (`PAYMENT_MODE=live`). Talks to Tripay's closed-payment REST
 * API over `fetch` (no new HTTP client dep — Node 22 ships a native
 * `fetch`, matching the "thin fetch client" guidance for this integration).
 *
 * ## Webhook security model (SECURITY-CRITICAL)
 * `verifyAndParseWebhook` is the ONLY authentication `POST /v1/webhooks/tripay`
 * has (the route is `@Public()` — no JWT, since Tripay is not a logged-in
 * user). It:
 *   1. Reads `X-Callback-Signature` and HMAC-SHA256-signs the RAW request
 *      body (before JSON parsing — Tripay signs the exact bytes it sent,
 *      and re-serializing a parsed object is not guaranteed byte-identical)
 *      with `TRIPAY_PRIVATE_KEY`.
 *   2. Compares with `timingSafeEqual` (constant-time — a `===` string
 *      compare would leak timing information an attacker could use to
 *      forge a valid signature byte-by-byte).
 *   3. Throws `UnauthorizedException` on ANY mismatch (wrong length too —
 *      `timingSafeEqual` throws on unequal-length buffers, caught below and
 *      normalized to the same 401, so a malformed header never leaks
 *      "your signature was the wrong length" as a distinguishable error).
 * Amount validation and idempotency are NOT this class's job — see
 * `PaymentIntentsService.settleFromGateway`, which this result feeds.
 */
@Injectable()
export class TripayPaymentGateway extends PaymentGateway {
  private readonly logger = new Logger(TripayPaymentGateway.name);
  private readonly apiKey: string;
  private readonly privateKey: string;
  private readonly merchantCode: string;
  private readonly baseUrl: string;

  constructor(config: ConfigService<{ app: AppConfig }, true>) {
    super();
    // Validated non-empty by envSchema's superRefine when PAYMENT_MODE=live
    // (the only mode this class is ever instantiated+selected for — see
    // invoices.module.ts) — the `?? ''` is a type-narrowing formality, not a
    // runtime fallback path that can actually be hit in that mode.
    this.apiKey = config.get('app.payment.tripay.apiKey', { infer: true }) ?? '';
    this.privateKey = config.get('app.payment.tripay.privateKey', { infer: true }) ?? '';
    this.merchantCode = config.get('app.payment.tripay.merchantCode', { infer: true }) ?? '';
    this.baseUrl = config.get('app.payment.tripay.baseUrl', { infer: true }) ?? '';
  }

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const method = TRIPAY_METHOD[input.channel];
    if (!method) {
      throw new Error(
        `no Tripay method code mapped for channel "${input.channel}" — see TRIPAY_METHOD in tripay-payment.gateway.ts`,
      );
    }

    const signature = createHmac('sha256', this.privateKey)
      .update(`${this.merchantCode}${input.merchantRef}${input.amount}`)
      .digest('hex');

    const body = {
      method,
      merchant_ref: input.merchantRef,
      amount: input.amount,
      customer_name: input.customer.name,
      customer_email: input.customer.email,
      customer_phone: input.customer.phone,
      order_items: [
        {
          sku: input.invoiceNo,
          name: `Invoice ${input.invoiceNo}`,
          price: input.amount,
          quantity: 1,
        },
      ],
      signature,
    };

    const res = await fetch(`${this.baseUrl}/transaction/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json()) as TripayCreateResponse;
    if (!res.ok || !json.success || !json.data) {
      this.logger.error(
        { status: res.status, message: json.message, merchantRef: input.merchantRef },
        'Tripay create-transaction failed',
      );
      throw new Error(`Tripay create-transaction failed: ${json.message ?? res.status}`);
    }

    return {
      reference: json.data.reference,
      payCode: json.data.pay_code ?? undefined,
      qrPayload: json.data.qr_string ?? json.data.qr_url ?? undefined,
      checkoutUrl: json.data.checkout_url ?? undefined,
      expiresAt: new Date(json.data.expired_time * 1000),
    };
  }

  verifyAndParseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): WebhookVerifyResult {
    const received = headers[CALLBACK_SIGNATURE_HEADER];
    const receivedSignature = Array.isArray(received) ? received[0] : received;
    if (!receivedSignature) {
      throw new UnauthorizedException('missing X-Callback-Signature header');
    }

    const expectedSignature = createHmac('sha256', this.privateKey).update(rawBody).digest('hex');

    if (!constantTimeHexEqual(receivedSignature, expectedSignature)) {
      this.logger.warn('Tripay webhook: signature mismatch — rejecting callback');
      throw new UnauthorizedException('invalid webhook signature');
    }

    let payload: TripayCallbackBody;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as TripayCallbackBody;
    } catch {
      throw new UnauthorizedException('malformed webhook body');
    }

    return {
      reference: payload.reference,
      invoiceRef: payload.merchant_ref,
      status: toSettlementStatus(payload.status),
      amount: payload.total_amount,
    };
  }
}

/** Constant-time hex-string compare — never throws on length mismatch
 *  (unlike a bare `timingSafeEqual`), so a malformed header can never
 *  distinguish "wrong length" from "wrong content" via a thrown error. */
function constantTimeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
