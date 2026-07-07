import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const EVENTS = [
  'invoice_created',
  'due_soon',
  'overdue',
  'isolir',
  'paid',
  'ticket_update',
  'wo_scheduled',
  'wo_done',
] as const;

/** Output shape for a notification template. */
export const NotificationTemplateResponseSchema = z.object({
  id: z.uuid(),
  event: z.enum(EVENTS),
  name: z.string(),
  channel: z.literal('whatsapp'),
  body: z.string(),
  enabled: z.boolean(),
});

export type NotificationTemplateResponse = z.infer<typeof NotificationTemplateResponseSchema>;

export class NotificationTemplateResponseDto extends createZodDto(
  NotificationTemplateResponseSchema,
) {}

/** Output shape for a send-log entry. */
export const NotificationLogResponseSchema = z.object({
  id: z.uuid(),
  to: z.string(),
  templateName: z.string(),
  channel: z.literal('whatsapp'),
  status: z.enum(['sent', 'failed']),
  body: z.string(),
  at: z.iso.datetime(),
});

export type NotificationLogResponse = z.infer<typeof NotificationLogResponseSchema>;

export class NotificationLogResponseDto extends createZodDto(NotificationLogResponseSchema) {}
