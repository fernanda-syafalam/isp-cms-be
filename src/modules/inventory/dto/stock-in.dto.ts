import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for POST /v1/inventory — register a new item into the warehouse. */
export const StockInSchema = z
  .object({
    kind: z.enum(['onu', 'router', 'mikrotik']),
    serial: z.string().trim().min(1).max(80),
  })
  .strict();

export type StockInInput = z.infer<typeof StockInSchema>;

export class StockInDto extends createZodDto(StockInSchema) {}
