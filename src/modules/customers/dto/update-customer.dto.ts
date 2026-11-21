import { createZodDto } from 'nestjs-zod';
import type { z } from 'zod';
import { CreateCustomerSchema } from './create-customer.dto';

/**
 * Input for PATCH /v1/customers/:id — base profile fields only, every
 * one optional. Lifecycle (status), balance and provisioning are changed
 * through dedicated action endpoints, never here. `planId` is omitted:
 * a plan change needs proration + secret-profile sync, so it only goes
 * through POST :id/change-plan. The schema stays `.strict()` (inherited
 * from the create schema), so a body carrying `planId` is a 400.
 */
export const UpdateCustomerSchema = CreateCustomerSchema.omit({ planId: true }).partial();

export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;

export class UpdateCustomerDto extends createZodDto(UpdateCustomerSchema) {}
