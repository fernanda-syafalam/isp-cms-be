import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output shape for a plan. `subscriberCount` is computed at list time
 * (how many active customers are on the plan) and is optional — single
 * mutation responses omit it. `@ZodSerializerDto` strips anything not
 * declared here.
 */
export const PlanResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  speedMbps: z.number().int(),
  priceMonthly: z.number().int(),
  status: z.enum(['active', 'archived']),
  subscriberCount: z.number().int().nonnegative().optional(),
});

export type PlanResponse = z.infer<typeof PlanResponseSchema>;

export class PlanResponseDto extends createZodDto(PlanResponseSchema) {}
