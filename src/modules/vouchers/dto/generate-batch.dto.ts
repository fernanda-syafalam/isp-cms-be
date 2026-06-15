import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/vouchers/batch — mint N identical vouchers in one
 * request. They share a batchId, profile, price and duration.
 */
export const GenerateBatchSchema = z
  .object({
    count: z.number().int().min(1).max(500),
    profile: z.string().trim().min(1).max(80),
    priceIdr: z.number().int().nonnegative(),
    durationDays: z.number().int().positive().max(365),
  })
  .strict();

export type GenerateBatchInput = z.infer<typeof GenerateBatchSchema>;

export class GenerateBatchDto extends createZodDto(GenerateBatchSchema) {}
