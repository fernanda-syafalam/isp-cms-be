import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentIntent } from '../../infrastructure/database/schema/invoices.schema';
import type { InvoiceResponse } from './dto/invoice-response.dto';
import { InvoicesService } from './invoices.service';
import { PaymentIntentsRepository } from './payment-intents.repository';
import { PaymentIntentsService } from './payment-intents.service';

const INVOICE_ID = '00000000-0000-0000-0000-0000000000e1';
const INTENT_ID = '00000000-0000-0000-0000-0000000000f1';

function invoice(over: Partial<InvoiceResponse> = {}): InvoiceResponse {
  return {
    id: INVOICE_ID,
    invoiceNo: 'INV-2026-100',
    customerId: '00000000-0000-0000-0000-0000000000c1',
    customerName: 'Budi Santoso',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    amount: 100_000,
    lateFee: 5_000,
    taxAmount: 11_000,
    discountAmount: 0,
    paidAmount: 0,
    balanceDue: 116_000,
    taxInvoiceNo: null,
    status: 'pending',
    dueDate: '2026-06-10',
    paidAt: null,
    lastRemindedAt: null,
    ...over,
  };
}

function intentRow(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: INTENT_ID,
    invoiceId: INVOICE_ID,
    invoiceNo: 'INV-2026-100',
    customerName: 'Budi Santoso',
    amount: 116_000,
    channel: 'qris',
    status: 'pending',
    vaNumber: null,
    qrPayload: 'ID.MOCK.QRIS|qris|INV-2026-100|116000',
    // A fresh intent is valid for 24h. Anchor to the run clock so the
    // not-yet-expired path never rots into a date-based flake; the
    // already-expired path overrides this with a fixed past date.
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    paidAt: null,
    createdAt: new Date(),
    ...over,
  };
}

describe('PaymentIntentsService', () => {
  let service: PaymentIntentsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let invoices: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    repo = {
      create: vi.fn((values) => Promise.resolve(intentRow({ ...values }))),
      findById: vi.fn(),
      markPaid: vi.fn(),
      markExpired: vi.fn(),
      expireStalePending: vi.fn(),
    };
    invoices = {
      findById: vi.fn(),
      pay: vi.fn(),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentIntentsService,
        { provide: PaymentIntentsRepository, useValue: repo },
        { provide: InvoicesService, useValue: invoices },
      ],
    }).compile();
    service = moduleRef.get(PaymentIntentsService);
  });

  describe('create', () => {
    it('charges the invoice total and issues a VA number for VA rails', async () => {
      invoices.findById.mockResolvedValue(invoice());

      const result = await service.create({ invoiceId: INVOICE_ID, channel: 'va_bca' });

      // amount = 100_000 + 5_000 (lateFee) + 11_000 (tax)
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 116_000, channel: 'va_bca', status: 'pending' }),
      );
      expect(result.vaNumber).toMatch(/^8808/);
      expect(result.qrPayload).toBeNull();
      expect(result.amount).toBe(116_000);
    });

    it('issues a QR payload (no VA number) for QR / e-wallet rails', async () => {
      invoices.findById.mockResolvedValue(invoice());

      const result = await service.create({ invoiceId: INVOICE_ID, channel: 'gopay' });

      expect(result.vaNumber).toBeNull();
      expect(result.qrPayload).toContain('gopay');
    });

    it('rejects a charge against an already-paid invoice', async () => {
      invoices.findById.mockResolvedValue(invoice({ status: 'paid' }));

      await expect(
        service.create({ invoiceId: INVOICE_ID, channel: 'qris' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('propagates a 404 from an unknown invoice', async () => {
      invoices.findById.mockRejectedValue(new NotFoundException('invoice not found'));

      await expect(
        service.create({ invoiceId: 'missing', channel: 'qris' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('confirm', () => {
    it('settles the invoice with the channel-mapped method and marks the intent paid', async () => {
      repo.findById.mockResolvedValue(intentRow({ channel: 'va_mandiri' }));
      repo.markPaid.mockResolvedValue(
        intentRow({ status: 'paid', paidAt: new Date('2026-06-16T01:00:00.000Z') }),
      );

      const result = await service.confirm(INTENT_ID);

      expect(invoices.pay).toHaveBeenCalledWith(INVOICE_ID, { method: 'va' });
      expect(repo.markPaid).toHaveBeenCalledWith(INTENT_ID);
      expect(result.status).toBe('paid');
      expect(result.paidAt).toBe('2026-06-16T01:00:00.000Z');
    });

    it('maps e-wallet rails to the ewallet payment method', async () => {
      repo.findById.mockResolvedValue(intentRow({ channel: 'ovo' }));
      repo.markPaid.mockResolvedValue(intentRow({ status: 'paid', channel: 'ovo' }));

      await service.confirm(INTENT_ID);

      expect(invoices.pay).toHaveBeenCalledWith(INVOICE_ID, { method: 'ewallet' });
    });

    it('is idempotent when the intent is already paid', async () => {
      repo.findById.mockResolvedValue(intentRow({ status: 'paid' }));

      const result = await service.confirm(INTENT_ID);

      expect(result.status).toBe('paid');
      expect(invoices.pay).not.toHaveBeenCalled();
      expect(repo.markPaid).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown intent', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.confirm('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an already-expired intent', async () => {
      repo.findById.mockResolvedValue(intentRow({ status: 'expired' }));
      await expect(service.confirm(INTENT_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(repo.markExpired).not.toHaveBeenCalled();
    });

    it('expires a lapsed pending intent and rejects confirmation', async () => {
      repo.findById.mockResolvedValue(
        intentRow({ expiresAt: new Date('2020-01-01T00:00:00.000Z') }),
      );

      await expect(service.confirm(INTENT_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(repo.markExpired).toHaveBeenCalledWith(INTENT_ID);
      expect(invoices.pay).not.toHaveBeenCalled();
    });
  });

  describe('customer-scoped variants (portal, P0.4)', () => {
    const OWNER_ID = '00000000-0000-0000-0000-0000000000c1';
    const STRANGER_ID = '00000000-0000-0000-0000-0000000000c2';

    it('createForCustomer charges the customer own invoice', async () => {
      invoices.findById.mockResolvedValue(invoice({ customerId: OWNER_ID }));

      const result = await service.createForCustomer(OWNER_ID, {
        invoiceId: INVOICE_ID,
        channel: 'qris',
      });

      expect(result.invoiceId).toBe(INVOICE_ID);
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('createForCustomer 404s on someone else invoice without creating a charge', async () => {
      invoices.findById.mockResolvedValue(invoice({ customerId: OWNER_ID }));

      await expect(
        service.createForCustomer(STRANGER_ID, { invoiceId: INVOICE_ID, channel: 'qris' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('confirmForCustomer settles the customer own intent', async () => {
      repo.findById.mockResolvedValue(intentRow());
      repo.markPaid.mockResolvedValue(intentRow({ status: 'paid', paidAt: new Date() }));
      invoices.findById.mockResolvedValue(invoice({ customerId: OWNER_ID }));

      const result = await service.confirmForCustomer(OWNER_ID, INTENT_ID);

      expect(result.status).toBe('paid');
      expect(invoices.pay).toHaveBeenCalledWith(INVOICE_ID, { method: 'qris' });
    });

    it('confirmForCustomer 404s on someone else intent without settling', async () => {
      repo.findById.mockResolvedValue(intentRow());
      invoices.findById.mockResolvedValue(invoice({ customerId: OWNER_ID }));

      await expect(service.confirmForCustomer(STRANGER_ID, INTENT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(invoices.pay).not.toHaveBeenCalled();
      expect(repo.markPaid).not.toHaveBeenCalled();
    });

    it('confirmForCustomer 404s on an unknown intent', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.confirmForCustomer(OWNER_ID, 'missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('expireStale (P2.1)', () => {
    it('bulk-expires stale pending intents and reports the count', async () => {
      repo.expireStalePending.mockResolvedValue(3);

      const result = await service.expireStale();

      expect(result).toEqual({ expired: 3 });
      expect(repo.expireStalePending).toHaveBeenCalledWith(expect.any(Date));
    });
  });
});
