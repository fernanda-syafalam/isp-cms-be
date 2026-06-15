import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/resellers/:id/ledger. `amount` is always positive; the
 * sign is applied server-side from `type` (topup/commission credit,
 * deduction/withdrawal debit).
 */
export const AddLedgerEntrySchema = z
  .object({
    type: z.enum(['topup', 'commission', 'deduction', 'withdrawal']),
    amount: z.number().int().positive(),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

export type AddLedgerEntryInput = z.infer<typeof AddLedgerEntrySchema>;

export class AddLedgerEntryDto extends createZodDto(AddLedgerEntrySchema) {}
