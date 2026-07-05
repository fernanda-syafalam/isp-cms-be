import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for POST /v1/work-orders/:id/reschedule — a new install date/time. */
export const RescheduleWorkOrderSchema = z
  .object({
    // The FE schedules with a date picker; accept an ISO date or datetime.
    scheduledAt: z.union([z.iso.date(), z.iso.datetime()]),
  })
  .strict();

export type RescheduleWorkOrderInput = z.infer<typeof RescheduleWorkOrderSchema>;

export class RescheduleWorkOrderDto extends createZodDto(RescheduleWorkOrderSchema) {}
