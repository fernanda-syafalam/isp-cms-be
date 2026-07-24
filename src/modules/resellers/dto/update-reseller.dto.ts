import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for PATCH /v1/resellers/:id (also used to deactivate). */
export const UpdateResellerSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    area: z.string().trim().min(1).max(120).optional(),
    // Fraction 0..1 (ADR-0010); bounded to the numeric(6,5) column range
    // so a >1 (>100%) value is a 400, not a DB numeric-overflow 500.
    commissionPct: z.number().nonnegative().max(1).optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict();

export type UpdateResellerInput = z.infer<typeof UpdateResellerSchema>;

export class UpdateResellerDto extends createZodDto(UpdateResellerSchema) {}
