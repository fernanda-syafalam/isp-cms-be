import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output shape for a work order. customerId is null for a dispatch with
 * no matching subscriber; technician is a free-text name.
 */
export const WorkOrderResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  type: z.enum(['install', 'repair', 'dismantle']),
  customerId: z.uuid().nullable(),
  customerName: z.string(),
  technician: z.string().nullable(),
  scheduledAt: z.iso.datetime(),
  status: z.enum(['scheduled', 'in_progress', 'done', 'cancelled']),
  // Set only for a repair WO dispatched from a ticket (P3.B.4). Completing
  // such a WO auto-resolves the linked ticket.
  ticketId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export type WorkOrderResponse = z.infer<typeof WorkOrderResponseSchema>;

export class WorkOrderResponseDto extends createZodDto(WorkOrderResponseSchema) {}
