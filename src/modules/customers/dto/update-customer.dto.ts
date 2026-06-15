import { createZodDto } from 'nestjs-zod';
import type { z } from 'zod';
import { CreateCustomerSchema } from './create-customer.dto';

/**
 * Input for PATCH /v1/customers/:id — base profile fields only, every
 * one optional. Lifecycle (status), balance and provisioning are changed
 * through dedicated action endpoints, never here.
 */
export const UpdateCustomerSchema = CreateCustomerSchema.partial();

export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;

export class UpdateCustomerDto extends createZodDto(UpdateCustomerSchema) {}
