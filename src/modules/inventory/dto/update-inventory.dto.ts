import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for PATCH /v1/inventory/:id — direct field correction (no movement
 * logged). `assignedTo: null` clears the assignment.
 */
export const UpdateInventorySchema = z
  .object({
    kind: z.enum(['onu', 'router', 'mikrotik']).optional(),
    serial: z.string().trim().min(1).max(80).optional(),
    status: z.enum(['warehouse', 'installed', 'broken']).optional(),
    assignedTo: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

export type UpdateInventoryInput = z.infer<typeof UpdateInventorySchema>;

export class UpdateInventoryDto extends createZodDto(UpdateInventorySchema) {}
