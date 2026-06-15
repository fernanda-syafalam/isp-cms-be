import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/inventory/:id/move. `assign` installs the item to a
 * subscriber (note = name), `return` sends it back to the warehouse,
 * `broken` retires it. `in` is not a move — that is stock-in.
 */
export const MoveInventorySchema = z
  .object({
    type: z.enum(['assign', 'return', 'broken']),
    note: z.string().trim().max(120).optional(),
  })
  .strict();

export type MoveInventoryInput = z.infer<typeof MoveInventorySchema>;

export class MoveInventoryDto extends createZodDto(MoveInventorySchema) {}
