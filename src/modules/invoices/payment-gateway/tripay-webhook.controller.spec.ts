import { Logger, UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaymentIntentsService } from '../payment-intents.service';
import { MalformedWebhookError, type PaymentGateway } from './payment-gateway';
import { TripayWebhookController } from './tripay-webhook.controller';

describe('TripayWebhookController (M1)', () => {
  const verify = vi.fn();
  const settleFromGateway = vi.fn();
  const markGatewayNonSettlement = vi.fn();
  const controller = new TripayWebhookController(
    { verifyAndParseWebhook: verify } as unknown as PaymentGateway,
    { settleFromGateway, markGatewayNonSettlement } as unknown as PaymentIntentsService,
  );
  const req = { rawBody: Buffer.from('{}') } as Parameters<TripayWebhookController['handle']>[0];

  afterEach(() => vi.restoreAllMocks());

  it('acks a signed-but-malformed body with an audit log and never touches intents', async () => {
    verify.mockImplementation(() => {
      throw new MalformedWebhookError();
    });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(controller.handle(req, {})).resolves.toEqual({ received: true });

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ audit: true }), expect.any(String));
    expect(settleFromGateway).not.toHaveBeenCalled();
    expect(markGatewayNonSettlement).not.toHaveBeenCalled();
  });

  it('propagates UnauthorizedException from a bad signature', async () => {
    verify.mockImplementation(() => {
      throw new UnauthorizedException('invalid webhook signature');
    });

    await expect(controller.handle(req, {})).rejects.toThrow(UnauthorizedException);
    expect(settleFromGateway).not.toHaveBeenCalled();
  });
});
