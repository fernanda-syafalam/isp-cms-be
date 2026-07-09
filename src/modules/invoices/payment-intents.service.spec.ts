import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentIntent } from '../../infrastructure/database/schema/invoices.schema';
import { CustomersRepository } from '../customers/customers.repository';
import type { InvoiceResponse } from './dto/invoice-response.dto';
import { InvoicesService } from './invoices.service';
import { PaymentGateway } from './payment-gateway/payment-gateway';
import { SimulationPaymentGateway } from './payment-gateway/simulation-payment.gateway';
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
    type: 'regular',
    note: null,
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
    gatewayReference: 'SIM-00000000-0000-0000-0000-0000000000f1',
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
  let customers: Record<string, ReturnType<typeof vi.fn>>;

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
    customers = {
      findById: vi.fn(async () => null),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentIntentsService,
        { provide: PaymentIntentsRepository, useValue: repo },
        { provide: InvoicesService, useValue: invoices },
        { provide: CustomersRepository, useValue: customers },
        // The REAL simulation gateway (not a mock) — proves the create()
        // refactor stays byte-compatible with the pre-adapter mock VA/QR
        // behaviour (regression coverage for the Tripay seam). The gateway
        // implementation itself has its own dedicated spec.
        { provide: PaymentGateway, useClass: SimulationPaymentGateway },
      ],
    }).compile();
    service = moduleRef.get(PaymentIntentsService);
  });

  describe('create', () => {
    it('charges the invoice balanceDue (amount + lateFee + tax, no discount/prior payment here) and issues a VA number for VA rails', async () => {
      invoices.findById.mockResolvedValue(invoice());

      const result = await service.create({ invoiceId: INVOICE_ID, channel: 'va_bca' });

      // balanceDue = 100_000 + 5_000 (lateFee) + 11_000 (tax) - 0 (discount) - 0 (paid)
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 116_000, channel: 'va_bca', status: 'pending' }),
      );
      expect(result.vaNumber).toMatch(/^8808/);
      expect(result.qrPayload).toBeNull();
      expect(result.amount).toBe(116_000);
    });

    // C4: the intent must charge exactly what's still owed, never the gross
    // amount + lateFee + taxAmount — that overstates a VA/QR charge once a
    // real gateway settles on the intent amount (SLA-credit discount case).
    it('charges the balanceDue net of a discount (SLA credit), not the gross total', async () => {
      invoices.findById.mockResolvedValue(
        invoice({
          amount: 200_000,
          lateFee: 0,
          taxAmount: 22_000,
          discountAmount: 50_000,
          balanceDue: 172_000,
        }),
      );

      const result = await service.create({ invoiceId: INVOICE_ID, channel: 'qris' });

      // Gross would be 222_000 — must charge the net 172_000 instead.
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 172_000 }));
      expect(result.amount).toBe(172_000);
    });

    // C4: same principle for a prior partial payment — the intent must only
    // ask for what's left, not re-charge the full gross total.
    it('charges the balanceDue net of a prior partial payment, not the gross total', async () => {
      invoices.findById.mockResolvedValue(
        invoice({
          amount: 200_000,
          lateFee: 0,
          taxAmount: 22_000,
          paidAmount: 100_000,
          balanceDue: 122_000,
        }),
      );

      const result = await service.create({ invoiceId: INVOICE_ID, channel: 'va_bca' });

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 122_000 }));
      expect(result.amount).toBe(122_000);
    });

    // C4: nothing left to pay must reject up front — a real gateway must
    // never be handed a zero/negative charge.
    it('rejects creating an intent when the invoice has no balance due', async () => {
      invoices.findById.mockResolvedValue(invoice({ balanceDue: 0 }));

      await expect(
        service.create({ invoiceId: INVOICE_ID, channel: 'qris' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.create).not.toHaveBeenCalled();
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

  // The Tripay webhook's settlement path (ADR-0016) — reuses confirm()
  // internally, so these focus on the extra checks the webhook needs:
  // resolve-by-reference, reference/amount validation, and dedupe.
  describe('settleFromGateway (webhook settlement, ADR-0016)', () => {
    const GATEWAY_REFERENCE = 'T1234567890';

    it('settles a matching paid callback via confirm()', async () => {
      repo.findById.mockResolvedValue(
        intentRow({ status: 'pending', gatewayReference: GATEWAY_REFERENCE }),
      );
      invoices.findById.mockResolvedValue(invoice({ balanceDue: 116_000 }));
      repo.markPaid.mockResolvedValue(intentRow({ status: 'paid' }));

      const result = await service.settleFromGateway({
        reference: GATEWAY_REFERENCE,
        invoiceRef: INTENT_ID,
        amount: 116_000,
      });

      expect(result).toEqual({ settled: true });
      expect(invoices.pay).toHaveBeenCalledWith(INVOICE_ID, { method: 'qris' });
      expect(repo.markPaid).toHaveBeenCalledWith(INTENT_ID);
    });

    it('is idempotent for a redelivered callback on an already-settled intent (one settle, no double ledger row)', async () => {
      repo.findById.mockResolvedValue(
        intentRow({ status: 'paid', gatewayReference: GATEWAY_REFERENCE }),
      );

      const result = await service.settleFromGateway({
        reference: GATEWAY_REFERENCE,
        invoiceRef: INTENT_ID,
        amount: 116_000,
      });

      expect(result).toEqual({ settled: true });
      expect(invoices.pay).not.toHaveBeenCalled();
      expect(repo.markPaid).not.toHaveBeenCalled();
    });

    // M1: a deterministic non-settle condition is reported via the return
    // value, NOT a thrown exception — the controller must be able to 200
    // (acknowledge, no retry) rather than ask Tripay to retry a permanent
    // condition forever. See settleFromGateway's doc comment.
    it('returns settled:false with reason "amount_mismatch" (does not throw) when the callback amount does not match balanceDue', async () => {
      repo.findById.mockResolvedValue(
        intentRow({ status: 'pending', gatewayReference: GATEWAY_REFERENCE }),
      );
      invoices.findById.mockResolvedValue(invoice({ balanceDue: 116_000 }));

      const result = await service.settleFromGateway({
        reference: GATEWAY_REFERENCE,
        invoiceRef: INTENT_ID,
        amount: 1, // attacker/bug: far below the real balance due
      });

      expect(result).toEqual({ settled: false, reason: 'amount_mismatch' });
      expect(invoices.pay).not.toHaveBeenCalled();
      expect(repo.markPaid).not.toHaveBeenCalled();
    });

    it('returns settled:false with reason "reference_mismatch" (does not throw) when the callback reference does not match the one recorded at charge-create time', async () => {
      repo.findById.mockResolvedValue(
        intentRow({ status: 'pending', gatewayReference: 'T-the-real-one' }),
      );

      const result = await service.settleFromGateway({
        reference: 'T-a-forged-one',
        invoiceRef: INTENT_ID,
        amount: 116_000,
      });

      expect(result).toEqual({ settled: false, reason: 'reference_mismatch' });
      expect(invoices.pay).not.toHaveBeenCalled();
    });

    it('returns settled:false with reason "unknown_intent" (does not throw) for an unknown invoiceRef (merchant_ref)', async () => {
      repo.findById.mockResolvedValue(null);

      const result = await service.settleFromGateway({
        reference: GATEWAY_REFERENCE,
        invoiceRef: 'missing',
        amount: 1,
      });

      expect(result).toEqual({ settled: false, reason: 'unknown_intent' });
      expect(invoices.pay).not.toHaveBeenCalled();
    });
  });

  // L3: a verified but non-'paid' callback ('expired'/'failed') marks the
  // intent expired immediately instead of waiting for the hourly sweep —
  // and never touches the invoice/money path.
  describe('markGatewayNonSettlement (L3)', () => {
    it('marks a pending intent expired', async () => {
      repo.findById.mockResolvedValue(intentRow({ status: 'pending' }));

      await service.markGatewayNonSettlement(INTENT_ID);

      expect(repo.markExpired).toHaveBeenCalledWith(INTENT_ID);
      expect(invoices.pay).not.toHaveBeenCalled();
    });

    it('is a no-op for an already-paid intent (never touches money)', async () => {
      repo.findById.mockResolvedValue(intentRow({ status: 'paid' }));

      await service.markGatewayNonSettlement(INTENT_ID);

      expect(repo.markExpired).not.toHaveBeenCalled();
    });

    it('is a no-op for an already-expired intent (idempotent for a redelivered callback)', async () => {
      repo.findById.mockResolvedValue(intentRow({ status: 'expired' }));

      await service.markGatewayNonSettlement(INTENT_ID);

      expect(repo.markExpired).not.toHaveBeenCalled();
    });

    it('is a no-op for an unknown intent', async () => {
      repo.findById.mockResolvedValue(null);

      await service.markGatewayNonSettlement('missing');

      expect(repo.markExpired).not.toHaveBeenCalled();
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

    // findForCustomer (SEC-H1 interim fix): a customer may only poll the
    // status of their own intent — settlement (`confirm`) is no longer
    // reachable through any customer-scoped method at all.
    it('findForCustomer returns the customer own intent without settling anything', async () => {
      repo.findById.mockResolvedValue(intentRow());
      invoices.findById.mockResolvedValue(invoice({ customerId: OWNER_ID }));

      const result = await service.findForCustomer(OWNER_ID, INTENT_ID);

      expect(result.status).toBe('pending');
      expect(invoices.pay).not.toHaveBeenCalled();
      expect(repo.markPaid).not.toHaveBeenCalled();
    });

    it('findForCustomer 404s on someone else intent', async () => {
      repo.findById.mockResolvedValue(intentRow());
      invoices.findById.mockResolvedValue(invoice({ customerId: OWNER_ID }));

      await expect(service.findForCustomer(STRANGER_ID, INTENT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(invoices.pay).not.toHaveBeenCalled();
    });

    it('findForCustomer 404s on an unknown intent', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.findForCustomer(OWNER_ID, 'missing')).rejects.toBeInstanceOf(
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
