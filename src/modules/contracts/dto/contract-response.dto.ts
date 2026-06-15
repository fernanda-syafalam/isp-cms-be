import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a contract (PKS). */
export const ContractResponseSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  customerId: z.uuid(),
  customerName: z.string(),
  planName: z.string(),
  status: z.enum(['draft', 'sent', 'signed']),
  meterai: z.boolean(),
  createdAt: z.iso.datetime(),
  signedAt: z.iso.datetime().nullable(),
});

export type ContractResponse = z.infer<typeof ContractResponseSchema>;

export class ContractResponseDto extends createZodDto(ContractResponseSchema) {}
