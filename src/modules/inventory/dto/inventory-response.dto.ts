import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for an inventory item. */
export const InventoryItemResponseSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['onu', 'router', 'mikrotik']),
  serial: z.string(),
  status: z.enum(['warehouse', 'installed', 'broken']),
  assignedTo: z.string().nullable(),
  assignedCustomerId: z.uuid().nullable(),
});

export type InventoryItemResponse = z.infer<typeof InventoryItemResponseSchema>;

export class InventoryItemResponseDto extends createZodDto(InventoryItemResponseSchema) {}

/** Output shape for a stock movement (audit entry). */
export const StockMovementResponseSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  serial: z.string(),
  kind: z.enum(['onu', 'router', 'mikrotik']),
  type: z.enum(['in', 'assign', 'return', 'broken']),
  note: z.string(),
  at: z.iso.datetime(),
});

export type StockMovementResponse = z.infer<typeof StockMovementResponseSchema>;

export class StockMovementResponseDto extends createZodDto(StockMovementResponseSchema) {}
