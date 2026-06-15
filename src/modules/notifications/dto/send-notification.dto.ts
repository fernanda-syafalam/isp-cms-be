import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for POST /v1/notifications/send — fire the template for an event. */
export const SendNotificationSchema = z
  .object({
    event: z.enum(['invoice_created', 'due_soon', 'overdue', 'isolir', 'paid', 'ticket_update']),
    to: z.string().trim().min(6).max(20),
  })
  .strict();

export type SendNotificationInput = z.infer<typeof SendNotificationSchema>;

export class SendNotificationDto extends createZodDto(SendNotificationSchema) {}
