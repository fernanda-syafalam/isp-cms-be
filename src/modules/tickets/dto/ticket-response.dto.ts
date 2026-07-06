import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output shape for a ticket. customerId is null when the subject name did
 * not match a known subscriber; assignee is a free-text agent name.
 * `category`/`photoUrl` are set for portal-reported tickets; the `csat*`
 * trio is set once the customer rates a resolved/breached ticket (P3.C.2) —
 * all nullable so existing consumers parsing an older payload still work.
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
  category: z.enum(['koneksi_putus', 'lambat', 'tagihan', 'perangkat', 'lainnya']).nullable(),
  photoUrl: z.string().nullable(),
  csatRating: z.number().int().min(1).max(5).nullable(),
  csatComment: z.string().nullable(),
  csatAt: z.iso.datetime().nullable(),
});

export type TicketResponse = z.infer<typeof TicketResponseSchema>;

export class TicketResponseDto extends createZodDto(TicketResponseSchema) {}
