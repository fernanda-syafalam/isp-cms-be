import { createZodDto } from 'nestjs-zod';
import type { z } from 'zod';
import { CreatePlanSchema } from './create-plan.dto';

/**
 * Input for PATCH /v1/plans/:id — every field optional (partial patch).
 * `status` is not editable here; archiving goes through the dedicated
 * POST /v1/plans/:id/archive action.
 */
export const UpdatePlanSchema = CreatePlanSchema.partial();

export type UpdatePlanInput = z.infer<typeof UpdatePlanSchema>;

export class UpdatePlanDto extends createZodDto(UpdatePlanSchema) {}
