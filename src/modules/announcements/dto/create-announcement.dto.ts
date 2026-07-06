import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for POST /v1/announcements (staff-only). */
export const CreateAnnouncementSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(1000),
    severity: z.enum(['info', 'warning', 'outage']).default('info'),
    active: z.boolean().default(true),
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().optional(),
  })
  .strict();

export type CreateAnnouncementInput = z.infer<typeof CreateAnnouncementSchema>;
export class CreateAnnouncementDto extends createZodDto(CreateAnnouncementSchema) {}
