import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/customers. A new customer starts as `prospek`;
 * status, balance, area and provisioning are set by later actions, not
 * the client — `.strict()` blocks mass-assignment of those fields.
 *
 * `email` accepts '' as "no email" (the UI sends an empty string) and is
 * normalised to null in the service.
 */
export const CreateCustomerSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(6).max(20),
    email: z.union([z.email().max(255), z.literal('')]),
    address: z.string().trim().min(1).max(255),
    planId: z.uuid(),
    // Acquisition channel (ADR-0010): which reseller brought this
    // subscriber. Staff-set; a mitra's own reads are scoped server-side.
    resellerId: z.uuid().nullable().optional(),
  })
  .strict();

export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;

export class CreateCustomerDto extends createZodDto(CreateCustomerSchema) {}
