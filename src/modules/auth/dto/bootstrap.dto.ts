import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/auth/bootstrap (first-run create-admin). `.strict()`
 * rejects unknown fields — notably there is NO `role` field: the role is
 * forced to 'admin' server-side so this endpoint can never mint anything
 * else. Password rule mirrors CreateUserSchema.
 */
export const BootstrapSchema = z
  .object({
    email: z.email().max(255),
    fullName: z.string().trim().min(1).max(120),
    password: z.string().min(12).max(128),
  })
  .strict();

export type BootstrapInput = z.infer<typeof BootstrapSchema>;

export class BootstrapDto extends createZodDto(BootstrapSchema) {}
