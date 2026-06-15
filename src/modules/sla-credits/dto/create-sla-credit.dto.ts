import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/sla-credits. A credit starts `pending`; status and
 * the resolved customer/ticket ids are derived, not client-supplied.
 */
export const CreateSlaCreditSchema = z
  .object({
    customerName: z.string().trim().min(1).max(120),
    amount: z.number().int().positive(),
    reason: z.string().trim().min(1).max(200),
    ticketCode: z.string().trim().max(40).optional(),
  })
  .strict();

export type CreateSlaCreditInput = z.infer<typeof CreateSlaCreditSchema>;

export class CreateSlaCreditDto extends createZodDto(CreateSlaCreditSchema) {}
