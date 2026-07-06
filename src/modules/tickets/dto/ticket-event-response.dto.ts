import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a single timeline entry. */
export const TicketEventResponseSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  kind: z.enum(['created', 'comment', 'status', 'assign', 'workorder', 'csat']),
  author: z.string(),
  body: z.string(),
  at: z.iso.datetime(),
});

export type TicketEventResponse = z.infer<typeof TicketEventResponseSchema>;

export class TicketEventResponseDto extends createZodDto(TicketEventResponseSchema) {}
