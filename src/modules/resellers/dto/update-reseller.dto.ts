import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for PATCH /v1/resellers/:id (also used to deactivate). */
export const UpdateResellerSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    area: z.string().trim().min(1).max(120).optional(),
    commissionPct: z.number().nonnegative().max(100).optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict();

export type UpdateResellerInput = z.infer<typeof UpdateResellerSchema>;

export class UpdateResellerDto extends createZodDto(UpdateResellerSchema) {}
