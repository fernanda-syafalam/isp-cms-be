import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/tickets. A new ticket opens as `open`, unassigned;
 * status/assignee/SLA are derived, not client-supplied (`.strict()`).
 * `category`/`photoUrl` are optional — set when the report originates from
 * the customer portal (P3.C.2); staff-created tickets may omit them.
 */
export const CreateTicketSchema = z
  .object({
    subject: z.string().trim().min(1).max(160),
    customerName: z.string().trim().min(1).max(120),
    priority: z.enum(['low', 'medium', 'high', 'urgent']),
    category: z.enum(['koneksi_putus', 'lambat', 'tagihan', 'perangkat', 'lainnya']).optional(),
    photoUrl: z.url().max(500).optional(),
  })
  .strict();

export type CreateTicketInput = z.infer<typeof CreateTicketSchema>;

export class CreateTicketDto extends createZodDto(CreateTicketSchema) {}
