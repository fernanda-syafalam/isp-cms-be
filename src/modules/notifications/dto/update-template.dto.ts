import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for PATCH /v1/notifications/templates/:id. */
export const UpdateTemplateSchema = z
  .object({
    body: z.string().trim().min(1).max(1000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type UpdateTemplateInput = z.infer<typeof UpdateTemplateSchema>;

export class UpdateTemplateDto extends createZodDto(UpdateTemplateSchema) {}
