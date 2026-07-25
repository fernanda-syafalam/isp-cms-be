import { describe, expect, it } from 'vitest';
import { PortalPaymentResponseSchema } from './payment-response.dto';

// FIN-D security contract: the cashier `note` is a staff-only annotation about
// a customer and must NEVER be echoed back to that customer via the portal.
// The portal projection is an explicit allowlist (`pick`) — this test pins that
// so a future refactor (e.g. swapping it back to the full staff schema) cannot
// silently reintroduce the leak with the suite still green.
describe('PortalPaymentResponseSchema (FIN-D leak guard)', () => {
  const staffRow = {
    id: '11111111-1111-4111-8111-111111111111',
    invoiceId: '22222222-2222-4222-8222-222222222222',
    invoiceNo: 'INV-2026-08-0001',
    customerId: '33333333-3333-4333-8333-333333333333',
    customerName: 'Budi',
    amount: 100000,
    method: 'cash' as const,
    source: 'invoice' as const,
    voucherId: null,
    tenderedAmount: 100000,
    changeAmount: 0,
    note: 'paid at loket, gateway webhook was late', // staff-only annotation
    paidAt: '2026-08-01T02:00:00.000Z',
  };

  it('strips `note` from a payment row (never reaches the customer)', () => {
    const out = PortalPaymentResponseSchema.parse(staffRow);
    expect('note' in out).toBe(false);
    expect((out as Record<string, unknown>).note).toBeUndefined();
  });

  it('still carries the customer-safe fields', () => {
    const out = PortalPaymentResponseSchema.parse(staffRow);
    expect(out).toMatchObject({
      id: staffRow.id,
      invoiceNo: staffRow.invoiceNo,
      amount: staffRow.amount,
      method: 'cash',
      paidAt: staffRow.paidAt,
    });
  });
});
