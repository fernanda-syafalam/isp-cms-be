import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output shape for a ticket. customerId is null when the subject name did
 * not match a known subscriber; assignee is a free-text agent name.
 */
export const TicketResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  subject: z.string(),
  customerId: z.uuid().nullable(),
  customerName: z.string(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  status: z.enum(['open', 'in_progress', 'resolved', 'breached']),
  assignee: z.string().nullable(),
  slaDueAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export type TicketResponse = z.infer<typeof TicketResponseSchema>;

export class TicketResponseDto extends createZodDto(TicketResponseSchema) {}
