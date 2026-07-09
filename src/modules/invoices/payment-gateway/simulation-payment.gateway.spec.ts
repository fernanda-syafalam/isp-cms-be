import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { SimulationPaymentGateway } from './simulation-payment.gateway';

const CUSTOMER = { name: 'Budi Santoso' };

describe('SimulationPaymentGateway (ADR-0016)', () => {
  const gateway = new SimulationPaymentGateway();

  describe('createCharge', () => {
    it('issues a deterministic mock VA number for a VA channel, no qrPayload/checkoutUrl', async () => {
      const result = await gateway.createCharge({
        invoiceId: 'inv-1',
        invoiceNo: 'INV-2026-100',
        merchantRef: 'intent-1',
        amount: 116_000,
        channel: 'va_bca',
        customer: CUSTOMER,
      });

      expect(result.payCode).toMatch(/^8808/);
      expect(result.qrPayload).toBeUndefined();
      expect(result.checkoutUrl).toBeUndefined();
      expect(result.reference).toBe('SIM-intent-1');
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('uses the correct BIN prefix per bank', async () => {
      const banks: Array<['va_bca' | 'va_mandiri' | 'va_bri' | 'va_bni', string]> = [
        ['va_bca', '8808'],
        ['va_mandiri', '8950'],
        ['va_bri', '8888'],
        ['va_bni', '8810'],
      ];
      for (const [channel, prefix] of banks) {
        const result = await gateway.createCharge({
          invoiceId: 'inv-1',
          invoiceNo: 'INV-2026-100',
          merchantRef: 'intent-1',
          amount: 100_000,
          channel,
          customer: CUSTOMER,
        });
        expect(result.payCode?.startsWith(prefix)).toBe(true);
      }
    });

    it('issues a mock QR payload (no payCode) for QR / e-wallet rails', async () => {
      const result = await gateway.createCharge({
        invoiceId: 'inv-1',
        invoiceNo: 'INV-2026-100',
        merchantRef: 'intent-1',
        amount: 116_000,
        channel: 'gopay',
        customer: CUSTOMER,
      });

      expect(result.payCode).toBeUndefined();
      expect(result.qrPayload).toBe('ID.MOCK.QRIS|gopay|INV-2026-100|116000');
    });

    it('never calls a real network endpoint (ignores customer contact details)', async () => {
      // No email/phone at all — a real gateway would reject this; the
      // simulation gateway must never care, since it never dials out.
      await expect(
        gateway.createCharge({
          invoiceId: 'inv-1',
          invoiceNo: 'INV-2026-100',
          merchantRef: 'intent-1',
          amount: 1,
          channel: 'qris',
          customer: { name: 'No Contact' },
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('verifyAndParseWebhook', () => {
    it('is unreachable in simulation mode — fails closed with 401, not a 500', () => {
      expect(() => gateway.verifyAndParseWebhook({}, Buffer.from('{}'))).toThrow(
        UnauthorizedException,
      );
    });
  });
});
