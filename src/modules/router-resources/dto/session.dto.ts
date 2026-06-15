import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for an active PPPoE session (derived from enabled secrets). */
export const SessionResponseSchema = z.object({
  id: z.uuid(),
  routerId: z.uuid(),
  username: z.string(),
  address: z.string(),
  uptime: z.string(),
  callerId: z.string(),
});

export type SessionResponse = z.infer<typeof SessionResponseSchema>;
export class SessionResponseDto extends createZodDto(SessionResponseSchema) {}
