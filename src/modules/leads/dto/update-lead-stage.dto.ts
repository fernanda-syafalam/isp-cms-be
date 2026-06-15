import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for PATCH /v1/leads/:id/stage. */
export const UpdateLeadStageSchema = z
  .object({
    stage: z.enum(['new', 'survey', 'quote', 'won', 'lost']),
  })
  .strict();

export type UpdateLeadStageInput = z.infer<typeof UpdateLeadStageSchema>;

export class UpdateLeadStageDto extends createZodDto(UpdateLeadStageSchema) {}
