import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/tickets. A new ticket opens as `open`, unassigned;
 * status/assignee/SLA are derived, not client-supplied (`.strict()`).
 */
export const CreateTicketSchema = z
  .object({
    subject: z.string().trim().min(1).max(160),
    customerName: z.string().trim().min(1).max(120),
    priority: z.enum(['low', 'medium', 'high', 'urgent']),
  })
  .strict();

export type CreateTicketInput = z.infer<typeof CreateTicketSchema>;

export class CreateTicketDto extends createZodDto(CreateTicketSchema) {}
