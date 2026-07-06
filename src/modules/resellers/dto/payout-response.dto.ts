import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a reseller payout (P3.D.4 lifecycle). */
export const PayoutResponseSchema = z.object({
  id: z.uuid(),
  resellerId: z.uuid(),
  amount: z.number().int().positive(),
  status: z.enum(['requested', 'approved', 'rejected', 'paid']),
  note: z.string(),
  requestedBy: z.uuid().nullable(),
  decidedBy: z.uuid().nullable(),
  // Set only once the payout has been disbursed — the withdrawal ledger row.
  ledgerEntryId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
});

export type PayoutResponse = z.infer<typeof PayoutResponseSchema>;

export class PayoutResponseDto extends createZodDto(PayoutResponseSchema) {}
