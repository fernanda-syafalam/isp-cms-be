import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for POST /v1/work-orders/:id/assign — (re)assign the technician. */
export const AssignWorkOrderSchema = z
  .object({
    technician: z.string().trim().min(1).max(120),
  })
  .strict();

export type AssignWorkOrderInput = z.infer<typeof AssignWorkOrderSchema>;

export class AssignWorkOrderDto extends createZodDto(AssignWorkOrderSchema) {}
