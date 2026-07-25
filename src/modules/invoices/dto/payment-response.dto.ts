import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output shape for a recorded payment (the ledger). `amount` is however
 * much of the invoice this payment settled (the full total for a one-shot
 * payment, a partial slice for a loket instalment, P3.A.4). `tenderedAmount`
 * / `changeAmount` are set only for `method: 'cash'` (the loket drawer).
 *
 * `source` distinguishes an invoice settlement (the default) from a loket
 * voucher sale (P3.D.3) — a voucher-sourced row has `invoiceId`/`invoiceNo`
 * null and `voucherId` set instead; `customerId`/`customerName` are null
 * only for an anonymous hotspot voucher redemption.
 *
 * `note` (FIN-D) is the cashier's manual-entry justification — null for a
 * gateway-settled payment. STAFF-FACING ONLY: this schema is used directly
 * by `GET /v1/payments`; the customer portal deliberately uses
 * `PortalPaymentResponseSchema` (below), which omits `note`, so an internal
 * operator annotation about a customer is never echoed back to that same
 * customer.
 */
export const PaymentResponseSchema = z.object({
  id: z.uuid(),
  invoiceId: z.uuid().nullable(),
  invoiceNo: z.string().nullable(),
  customerId: z.uuid().nullable(),
  customerName: z.string().nullable(),
  amount: z.number().int().nonnegative(),
  method: z.enum(['qris', 'va', 'ewallet', 'transfer', 'cash']),
  source: z.enum(['invoice', 'voucher']),
  voucherId: z.uuid().nullable(),
  tenderedAmount: z.number().int().nonnegative().nullable(),
  changeAmount: z.number().int().nonnegative().nullable(),
  note: z.string().nullable(),
  paidAt: z.iso.datetime(),
});

export type PaymentResponse = z.infer<typeof PaymentResponseSchema>;

export class PaymentResponseDto extends createZodDto(PaymentResponseSchema) {}

/**
 * Customer-portal projection (FIN-D). The service layer still returns the full
 * `PaymentResponse` (with `note`) to `PortalService` — `@ZodSerializerDto` is
 * what actually strips undeclared fields for the portal response, so this
 * schema is the enforcement point, not a suggestion the caller must remember.
 *
 * Deliberately an explicit ALLOWLIST (`pick`), not `omit({ note })`: this is a
 * customer-facing money surface, so it must be **fail-closed** — a new field
 * added to the staff `PaymentResponseSchema` stays invisible to the portal
 * until someone consciously adds it here, rather than auto-leaking. `note` (the
 * internal cashier annotation) is simply absent from the allowlist.
 */
export const PortalPaymentResponseSchema = PaymentResponseSchema.pick({
  id: true,
  invoiceId: true,
  invoiceNo: true,
  customerId: true,
  customerName: true,
  amount: true,
  method: true,
  source: true,
  voucherId: true,
  tenderedAmount: true,
  changeAmount: true,
  paidAt: true,
});

export type PortalPaymentResponse = z.infer<typeof PortalPaymentResponseSchema>;
