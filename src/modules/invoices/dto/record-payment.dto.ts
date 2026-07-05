import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/invoices/:id/pay — how an offline / loket payment
 * was received. `amount` is optional and defaults to the full balance due
 * (server-computed) — set it to record a partial / instalment payment
 * (P3.A.4). `tenderedAmount` is only meaningful for `method: 'cash'` (the
 * loket drawer); the service computes and stores `changeAmount` from it.
 */
export const RecordPaymentSchema = z
  .object({
    method: z.enum(['qris', 'va', 'ewallet', 'transfer', 'cash']),
    amount: z.number().int().positive().optional(),
    tenderedAmount: z.number().int().nonnegative().optional(),
  })
  .strict();

export type RecordPaymentInput = z.infer<typeof RecordPaymentSchema>;

export class RecordPaymentDto extends createZodDto(RecordPaymentSchema) {}
