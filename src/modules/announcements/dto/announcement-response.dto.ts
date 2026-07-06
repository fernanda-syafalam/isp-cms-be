import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a portal/staff-visible announcement or outage notice. */
export const AnnouncementResponseSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  severity: z.enum(['info', 'warning', 'outage']),
  active: z.boolean(),
  startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export type AnnouncementResponse = z.infer<typeof AnnouncementResponseSchema>;
export class AnnouncementResponseDto extends createZodDto(AnnouncementResponseSchema) {}
