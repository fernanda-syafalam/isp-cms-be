import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/resellers/:id/payouts. Only creates a `requested` row;
 * the balance is untouched until the payout is later disbursed.
 */
export const CreatePayoutSchema = z
  .object({
    // Capped below int32 max so an out-of-range value is a clean 400, not a
    // Postgres "integer out of range" 500 on insert (security-review L2).
    amount: z.number().int().positive().max(2_000_000_000),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

export type CreatePayoutInput = z.infer<typeof CreatePayoutSchema>;

export class CreatePayoutDto extends createZodDto(CreatePayoutSchema) {}
