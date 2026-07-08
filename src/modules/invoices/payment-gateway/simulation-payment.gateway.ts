import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import {
  type CreateChargeInput,
  type CreateChargeResult,
  type PaymentChannel,
  PaymentGateway,
  type WebhookVerifyResult,
} from './payment-gateway';

// A gateway charge lives for one day before it lapses — unchanged from the
// pre-adapter behaviour in payment-intents.service.ts.
const INTENT_TTL_MS = 24 * 60 * 60 * 1000;

// Virtual-account BIN per bank (mock; real numbers come from the gateway).
const VA_PREFIX: Record<'va_bca' | 'va_mandiri' | 'va_bri' | 'va_bni', string> = {
  va_bca: '8808',
  va_mandiri: '8950',
  va_bri: '8888',
  va_bni: '8810',
};

/**
 * Default gateway (`PAYMENT_MODE=simulation`, dev/test/demo). Reproduces —
 * byte-for-byte — the mock VA/QR payload `PaymentIntentsService.create`
 * built inline before the adapter seam existed: same VA BIN prefixes, same
 * QR payload shape, same 24h TTL. No network call, no real money, and
 * `verifyAndParseWebhook` is unreachable in this mode (there is no route to
 * call it from — the dev/demo settlement path stays
 * `POST /v1/payments/intent/:id/confirm`, unchanged).
 */
@Injectable()
export class SimulationPaymentGateway extends PaymentGateway {
  private readonly logger = new Logger(SimulationPaymentGateway.name);

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const { channel, invoiceNo, amount, merchantRef } = input;
    this.logger.log(
      { merchantRef, channel, amount },
      'simulation: issuing mock VA/QR payload (no real gateway call)',
    );
    return Promise.resolve({
      // No real gateway transaction exists in simulation — the merchantRef
      // itself (== the intent id minted by the caller) doubles as the
      // reference so every CreateChargeResult always carries a non-empty
      // `reference`, matching the live contract's shape.
      reference: `SIM-${merchantRef}`,
      payCode: isVaChannel(channel) ? buildVaNumber(channel, invoiceNo) : undefined,
      qrPayload: isVaChannel(channel) ? undefined : buildQrPayload(channel, invoiceNo, amount),
      expiresAt: new Date(Date.now() + INTENT_TTL_MS),
    });
  }

  // Never actually called in simulation mode (no webhook route reaches a
  // gateway other than the one selected by PAYMENT_MODE=live), but a real
  // implementation is still provided rather than `throw new Error('not
  // implemented')` — a stray call fails closed with a clear 401 instead of
  // an unhandled 500.
  verifyAndParseWebhook(
    _headers: Record<string, string | string[] | undefined>,
    _rawBody: Buffer,
  ): WebhookVerifyResult {
    throw new UnauthorizedException('no gateway webhook is configured in PAYMENT_MODE=simulation');
  }
}

function isVaChannel(channel: PaymentChannel): channel is keyof typeof VA_PREFIX {
  return channel in VA_PREFIX;
}

function buildVaNumber(channel: keyof typeof VA_PREFIX, invoiceNo: string): string {
  const tail = invoiceNo.replace(/\D/g, '').slice(-10).padStart(10, '0');
  return `${VA_PREFIX[channel]}${tail}`;
}

function buildQrPayload(channel: PaymentChannel, invoiceNo: string, amount: number): string {
  return `ID.MOCK.QRIS|${channel}|${invoiceNo}|${amount}`;
}
