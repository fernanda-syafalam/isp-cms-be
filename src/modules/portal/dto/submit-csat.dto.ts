import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/portal/tickets/:id/csat — the customer rates a
 * resolved/breached ticket after the fact (P3.C.2). `comment` is optional.
 */
export const SubmitCsatSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(500).optional(),
  })
  .strict();

export type SubmitCsatInput = z.infer<typeof SubmitCsatSchema>;

export class SubmitCsatDto extends createZodDto(SubmitCsatSchema) {}
