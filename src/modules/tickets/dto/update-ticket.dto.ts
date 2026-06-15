import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for PATCH /v1/tickets/:id. Every field optional. `assignee: null`
 * unassigns. Changing priority recomputes the SLA deadline; changing
 * status / assignee appends a timeline event (handled in the service).
 */
export const UpdateTicketSchema = z
  .object({
    subject: z.string().trim().min(1).max(160).optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    status: z.enum(['open', 'in_progress', 'resolved', 'breached']).optional(),
    assignee: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

export type UpdateTicketInput = z.infer<typeof UpdateTicketSchema>;

export class UpdateTicketDto extends createZodDto(UpdateTicketSchema) {}
