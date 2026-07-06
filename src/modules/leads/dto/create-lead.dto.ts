import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/leads. A new lead enters at stage `new`; stage is
 * derived, not client-supplied (`.strict()`).
 */
export const CreateLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(1).max(20),
    address: z.string().trim().min(1).max(255),
    areaName: z.string().trim().min(1).max(120),
    planName: z.string().trim().min(1).max(80),
    estValue: z.number().int().nonnegative(),
    source: z.enum(['walk_in', 'referral', 'online', 'reseller']),
    note: z.string().trim().max(500).optional(),
    // Acquisition channel (P3.D.2): which reseller/mitra brought this lead.
    // Propagated to the customer on convert.
    resellerId: z.uuid().nullable().optional(),
  })
  .strict();

export type CreateLeadInput = z.infer<typeof CreateLeadSchema>;

export class CreateLeadDto extends createZodDto(CreateLeadSchema) {}
