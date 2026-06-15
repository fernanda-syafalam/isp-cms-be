import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output shape for a recorded payment (the ledger). `amount` is the full
 * invoice total that was settled.
 */
export const PaymentResponseSchema = z.object({
  id: z.uuid(),
  invoiceId: z.uuid(),
  invoiceNo: z.string(),
  customerId: z.uuid(),
  customerName: z.string(),
  amount: z.number().int().nonnegative(),
  method: z.enum(['qris', 'va', 'ewallet', 'transfer', 'cash']),
  paidAt: z.iso.datetime(),
});

export type PaymentResponse = z.infer<typeof PaymentResponseSchema>;

export class PaymentResponseDto extends createZodDto(PaymentResponseSchema) {}
