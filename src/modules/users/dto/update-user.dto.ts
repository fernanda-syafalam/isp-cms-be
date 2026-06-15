import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for PATCH /v1/users/:id. Only the mutable profile fields are
 * accepted — email (identity) and password (credential) are changed via
 * dedicated flows, never this generic update. `.strict()` blocks
 * mass-assignment of unknown keys; every field is optional so a partial
 * patch is valid.
 */
export const UpdateUserSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120).optional(),
    role: z.enum(['admin', 'staff', 'customer']).optional(),
  })
  .strict();

export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

export class UpdateUserDto extends createZodDto(UpdateUserSchema) {}
