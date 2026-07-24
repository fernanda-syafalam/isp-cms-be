import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/resellers. Balance always starts at 0 — funded via a
 * `topup` ledger entry, never set directly on create.
 */
export const CreateResellerSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    area: z.string().trim().min(1).max(120),
    // Commission rate as a fraction (e.g. 0.05 = 5%), 0..1 (ADR-0010).
    // Bounded to 1 to match the numeric(6,5) column (max 9.99999) — a >1
    // fraction is both nonsensical (>100%) and would overflow to a DB 500.
    commissionPct: z.number().nonnegative().max(1).default(0),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict();

export type CreateResellerInput = z.infer<typeof CreateResellerSchema>;

export class CreateResellerDto extends createZodDto(CreateResellerSchema) {}
