import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for an SLA credit. */
export const SlaCreditResponseSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid().nullable(),
  customerName: z.string(),
  amount: z.number().int().nonnegative(),
  reason: z.string(),
  ticketId: z.uuid().nullable(),
  ticketCode: z.string().nullable(),
  status: z.enum(['pending', 'applied', 'void']),
  createdAt: z.iso.datetime(),
  appliedAt: z.iso.datetime().nullable(),
});

export type SlaCreditResponse = z.infer<typeof SlaCreditResponseSchema>;

export class SlaCreditResponseDto extends createZodDto(SlaCreditResponseSchema) {}
