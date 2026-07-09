import { createHmac } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../config/configuration';
import { TripayPaymentGateway } from './tripay-payment.gateway';

const PRIVATE_KEY = 'test-tripay-private-key';
const MERCHANT_CODE = 'T0001';
const API_KEY = 'test-api-key';
const BASE_URL = 'https://tripay.test/api-sandbox';

function makeGateway(): TripayPaymentGateway {
  const configStub = {
    get: (path: string) => {
      const map: Record<string, string> = {
        'app.payment.tripay.apiKey': API_KEY,
        'app.payment.tripay.privateKey': PRIVATE_KEY,
        'app.payment.tripay.merchantCode': MERCHANT_CODE,
        'app.payment.tripay.baseUrl': BASE_URL,
      };
      return map[path];
    },
  } as unknown as ConfigService<{ app: AppConfig }, true>;
  return new TripayPaymentGateway(configStub);
}

function sign(body: Buffer | string): string {
  return createHmac('sha256', PRIVATE_KEY).update(body).digest('hex');
}

describe('TripayPaymentGateway (ADR-0016, live mode)', () => {
  let gateway: TripayPaymentGateway;

  beforeEach(() => {
    gateway = makeGateway();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createCharge', () => {
    it('calls Tripay create-transaction with a valid HMAC signature and maps the response', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              reference: 'T1234567890',
              pay_code: '8808123456',
              checkout_url: 'https://tripay.test/checkout/T1234567890',
              expired_time: Math.floor(new Date('2026-07-10T00:00:00.000Z').getTime() / 1000),
            },
          }),
          { status: 200 },
        ),
      );

      const result = await gateway.createCharge({
        invoiceId: 'inv-1',
        invoiceNo: 'INV-2026-100',
        merchantRef: 'intent-1',
        amount: 116_000,
        channel: 'va_bca',
        customer: { name: 'Budi Santoso', email: 'budi@example.test', phone: '0811' },
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(url).toBe(`${BASE_URL}/transaction/create`);
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);

      const sentBody = JSON.parse(init?.body as string) as {
        method: string;
        merchant_ref: string;
        amount: number;
        signature: string;
      };
      expect(sentBody.method).toBe('BCAVA');
      expect(sentBody.merchant_ref).toBe('intent-1');
      const expectedSignature = createHmac('sha256', PRIVATE_KEY)
        .update(`${MERCHANT_CODE}intent-1116000`)
        .digest('hex');
      expect(sentBody.signature).toBe(expectedSignature);

      expect(result).toEqual({
        reference: 'T1234567890',
        payCode: '8808123456',
        qrPayload: undefined,
        checkoutUrl: 'https://tripay.test/checkout/T1234567890',
        expiresAt: new Date('2026-07-10T00:00:00.000Z'),
      });
    });

    it('throws when Tripay responds with success: false', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ success: false, message: 'Invalid amount' }), {
          status: 422,
        }),
      );

      await expect(
        gateway.createCharge({
          invoiceId: 'inv-1',
          invoiceNo: 'INV-2026-100',
          merchantRef: 'intent-1',
          amount: 1,
          channel: 'qris',
          customer: { name: 'Budi Santoso' },
        }),
      ).rejects.toThrow('Tripay create-transaction failed');
    });

    it('throws for a channel with no mapped Tripay method code, without calling fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await expect(
        gateway.createCharge({
          invoiceId: 'inv-1',
          invoiceNo: 'INV-2026-100',
          merchantRef: 'intent-1',
          amount: 1,
          channel: 'ovo',
          customer: { name: 'Budi Santoso' },
        }),
      ).rejects.toThrow(/no Tripay method code mapped/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('verifyAndParseWebhook', () => {
    const body = {
      reference: 'T1234567890',
      merchant_ref: 'intent-1',
      status: 'PAID',
      total_amount: 116_000,
    };
    const rawBody = Buffer.from(JSON.stringify(body));

    it('accepts a valid signature and parses the callback', () => {
      const result = gateway.verifyAndParseWebhook(
        { 'x-callback-signature': sign(rawBody) },
        rawBody,
      );

      expect(result).toEqual({
        reference: 'T1234567890',
        invoiceRef: 'intent-1',
        status: 'paid',
        amount: 116_000,
      });
    });

    it('maps EXPIRED and any other status to expired/failed', () => {
      const expiredBody = Buffer.from(JSON.stringify({ ...body, status: 'EXPIRED' }));
      expect(
        gateway.verifyAndParseWebhook({ 'x-callback-signature': sign(expiredBody) }, expiredBody)
          .status,
      ).toBe('expired');

      const refundBody = Buffer.from(JSON.stringify({ ...body, status: 'REFUND' }));
      expect(
        gateway.verifyAndParseWebhook({ 'x-callback-signature': sign(refundBody) }, refundBody)
          .status,
      ).toBe('failed');
    });

    it('rejects a bad signature with UnauthorizedException, never parsing the body as authenticated', () => {
      expect(() =>
        gateway.verifyAndParseWebhook({ 'x-callback-signature': 'deadbeef' }, rawBody),
      ).toThrow(UnauthorizedException);
    });

    it('rejects a signature computed with the wrong key', () => {
      const wrongSignature = createHmac('sha256', 'not-the-real-private-key')
        .update(rawBody)
        .digest('hex');
      expect(() =>
        gateway.verifyAndParseWebhook({ 'x-callback-signature': wrongSignature }, rawBody),
      ).toThrow(UnauthorizedException);
    });

    it('rejects a signature computed over a tampered body (amount bumped up)', () => {
      const tamperedBody = Buffer.from(JSON.stringify({ ...body, total_amount: 999_999_999 }));
      // Signature is still valid for the ORIGINAL body — simulates an
      // attacker who intercepted a real callback and modified the amount
      // without re-signing (they don't have the private key).
      expect(() =>
        gateway.verifyAndParseWebhook({ 'x-callback-signature': sign(rawBody) }, tamperedBody),
      ).toThrow(UnauthorizedException);
    });

    it('rejects a missing signature header', () => {
      expect(() => gateway.verifyAndParseWebhook({}, rawBody)).toThrow(UnauthorizedException);
    });

    it('rejects a malformed body that passes signature verification', () => {
      const malformed = Buffer.from('not json');
      expect(() =>
        gateway.verifyAndParseWebhook({ 'x-callback-signature': sign(malformed) }, malformed),
      ).toThrow(UnauthorizedException);
    });
  });
});
