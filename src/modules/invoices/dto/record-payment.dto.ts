import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/invoices/:id/pay — how an offline / loket payment
 * was received. `amount` is optional and defaults to the full balance due
 * (server-computed) — set it to record a partial / instalment payment
 * (P3.A.4). `tenderedAmount` is only meaningful for `method: 'cash'` (the
 * loket drawer); the service computes and stores `changeAmount` from it.
 * `note` (FIN-D go-live finding) is the cashier's justification for
 * recording this MANUALLY — e.g. money already arrived via the gateway but
 * the webhook was slow, so staff keyed it in by hand at the counter.
 * Optional and free-text, but capped and trimmed; an empty/whitespace-only
 * string is normalized to "no note" by the service, never stored as ''.
 */
export const RecordPaymentSchema = z
  .object({
    method: z.enum(['qris', 'va', 'ewallet', 'transfer', 'cash']),
    amount: z.number().int().positive().optional(),
    tenderedAmount: z.number().int().nonnegative().optional(),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

export type RecordPaymentInput = z.infer<typeof RecordPaymentSchema>;

export class RecordPaymentDto extends createZodDto(RecordPaymentSchema) {}
