import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for POST /v1/notifications/send — fire the template for an event. */
export const SendNotificationSchema = z
  .object({
    event: z.enum([
      'invoice_created',
      'due_soon',
      'overdue',
      'isolir',
      'paid',
      'ticket_update',
      'wo_scheduled',
      'wo_done',
    ]),
    to: z.string().trim().min(6).max(20),
    // Template substitution values (e.g. { nama, no_tagihan, jumlah }). Real
    // per-recipient context (P2.2) — the render leaves any missing placeholder
    // literal rather than inventing a sample value.
    vars: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type SendNotificationInput = z.infer<typeof SendNotificationSchema>;

export class SendNotificationDto extends createZodDto(SendNotificationSchema) {}
