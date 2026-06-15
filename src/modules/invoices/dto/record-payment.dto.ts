import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/invoices/:id/pay — how an offline / loket payment
 * was received. The amount is the invoice total, never client-supplied.
 */
export const RecordPaymentSchema = z
  .object({
    method: z.enum(['qris', 'va', 'ewallet', 'transfer', 'cash']),
  })
  .strict();

export type RecordPaymentInput = z.infer<typeof RecordPaymentSchema>;

export class RecordPaymentDto extends createZodDto(RecordPaymentSchema) {}
