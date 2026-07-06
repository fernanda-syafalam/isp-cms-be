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
  paidAt: z.iso.datetime(),
});

export type PaymentResponse = z.infer<typeof PaymentResponseSchema>;

export class PaymentResponseDto extends createZodDto(PaymentResponseSchema) {}
