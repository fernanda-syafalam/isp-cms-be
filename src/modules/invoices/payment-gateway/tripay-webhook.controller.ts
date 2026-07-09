import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../../common/decorators/public.decorator';
import { PaymentIntentsService } from '../payment-intents.service';
import { PaymentGateway } from './payment-gateway';

/**
 * `POST /v1/webhooks/tripay` — Tripay's settlement callback. `@Public()`
 * because the caller is Tripay's server, not a logged-in user; there is no
 * JWT to check. Authentication is entirely `gateway.verifyAndParseWebhook`'s
 * job (HMAC-SHA256 over the raw body, see `TripayPaymentGateway`'s doc
 * comment) — this controller stays thin: verify, then delegate to
 * `PaymentIntentsService.settleFromGateway` (idempotency + amount check +
 * the actual `invoices.pay` transaction all live there, reused from the
 * existing `confirm()` path — SEC-H1: never reimplemented here).
 *
 * M1: this handler always 200s once the signature is valid — including for
 * an already-settled duplicate, a non-'paid' status (`markGatewayNonSettlement`),
 * AND a DETERMINISTIC reason `settleFromGateway` refused to settle (unknown
 * intent / reference mismatch / amount mismatch). Refusing to settle is
 * still the correct MONEY decision in all three cases (never paper over a
 * mismatch) — each is logged as an `audit: true` reconciliation alert at
 * the service layer for a human to follow up on — but retrying the exact
 * same callback can never turn a permanent condition into a success, so
 * asking Tripay to retry it (a non-2xx) would only produce a retry storm
 * with no chance of ever resolving. Only an invalid/missing signature (not
 * authenticated as Tripay at all) returns non-2xx (401, via the gateway); a
 * genuinely transient failure (e.g. the DB call itself throwing) is not
 * caught here and propagates as a 5xx, which IS a case Tripay should retry.
 */
@Public()
@Controller({ path: 'webhooks', version: '1' })
export class TripayWebhookController {
  constructor(
    private readonly gateway: PaymentGateway,
    private readonly intents: PaymentIntentsService,
  ) {}

  @Post('tripay')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ received: true }> {
    // Raw bytes ONLY — verifying a re-serialized JSON.parse(body) would
    // silently diverge from what Tripay actually signed (key order, exact
    // whitespace) and could theoretically be tricked into a false match.
    // `req.rawBody` comes from `rawBody: true` in main.ts's NestFactory
    // options; if it is ever missing (misconfiguration), fail closed
    // instead of falling back to a re-serialized body.
    if (!req.rawBody) {
      throw new UnauthorizedException('raw body unavailable — cannot verify webhook signature');
    }
    const parsed = this.gateway.verifyAndParseWebhook(headers, req.rawBody);

    if (parsed.status === 'paid') {
      // `settleFromGateway` never throws for a deterministic non-settle
      // reason (see its + this controller's doc comments) — its own
      // `audit: true` log line is the reconciliation alert; nothing further
      // to do here regardless of `result.settled`.
      await this.intents.settleFromGateway(parsed);
    } else {
      // 'expired' / 'failed' (L3) — no money path, just intent housekeeping
      // so it stops looking "still resumable" to the customer.
      await this.intents.markGatewayNonSettlement(parsed.invoiceRef);
    }

    return { received: true };
  }
}
