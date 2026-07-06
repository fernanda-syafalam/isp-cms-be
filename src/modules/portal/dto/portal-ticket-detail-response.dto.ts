import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { TicketEventResponseSchema } from '../../tickets/dto/ticket-event-response.dto';
import { TicketResponseSchema } from '../../tickets/dto/ticket-response.dto';

/**
 * Output shape for GET /v1/portal/tickets/:id — the ticket plus its full
 * comment/status timeline, scoped to the requesting customer (P3.C.2).
 * Composed from the existing ticket DTOs, never re-declared.
 */
export const PortalTicketDetailResponseSchema = TicketResponseSchema.extend({
  events: z.array(TicketEventResponseSchema),
});

export type PortalTicketDetailResponse = z.infer<typeof PortalTicketDetailResponseSchema>;

export class PortalTicketDetailResponseDto extends createZodDto(PortalTicketDetailResponseSchema) {}
