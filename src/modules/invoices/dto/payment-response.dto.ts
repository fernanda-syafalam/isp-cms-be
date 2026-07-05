import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output shape for a recorded payment (the ledger). `amount` is however
 * much of the invoice this payment settled (the full total for a one-shot
 * payment, a partial slice for a loket instalment, P3.A.4). `tenderedAmount`
 * / `changeAmount` are set only for `method: 'cash'` (the loket drawer).
 */
export const PaymentResponseSchema = z.object({
  id: z.uuid(),
  invoiceId: z.uuid(),
  invoiceNo: z.string(),
  customerId: z.uuid(),
  customerName: z.string(),
  amount: z.number().int().nonnegative(),
  method: z.enum(['qris', 'va', 'ewallet', 'transfer', 'cash']),
  tenderedAmount: z.number().int().nonnegative().nullable(),
  changeAmount: z.number().int().nonnegative().nullable(),
  paidAt: z.iso.datetime(),
});

export type PaymentResponse = z.infer<typeof PaymentResponseSchema>;

export class PaymentResponseDto extends createZodDto(PaymentResponseSchema) {}
