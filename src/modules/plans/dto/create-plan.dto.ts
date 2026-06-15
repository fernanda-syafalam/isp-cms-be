import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/plans. `.strict()` blocks mass-assignment of
 * unknown keys (e.g. a client trying to set `status` or `id`).
 */
export const CreatePlanSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    speedMbps: z.number().int().positive(),
    priceMonthly: z.number().int().nonnegative(),
  })
  .strict();

export type CreatePlanInput = z.infer<typeof CreatePlanSchema>;

export class CreatePlanDto extends createZodDto(CreatePlanSchema) {}
