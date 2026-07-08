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
 * comment) — this controller stays thin: verify, then delegate settlement
 * to `PaymentIntentsService.settleFromGateway` (idempotency + amount check
 * + the actual `invoices.pay` transaction all live there, reused from the
 * existing `confirm()` path — SEC-H1: never reimplemented here).
 *
 * Always 200s once the signature is valid, even for a status this handler
 * doesn't settle (e.g. 'failed') or an already-settled duplicate — Tripay
 * retries on any non-2xx, and none of those cases should trigger a retry
 * storm. Only an invalid signature returns non-2xx (401, via the gateway).
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
      await this.intents.settleFromGateway(parsed);
    } else {
      // 'expired' / 'failed' — acknowledged, nothing to settle. Logged at
      // the service layer would require a call just for a log line, so a
      // dedicated no-op path here is preferable — Tripay must still get a
      // 200 or it will keep retrying this webhook forever.
    }

    return { received: true };
  }
}
