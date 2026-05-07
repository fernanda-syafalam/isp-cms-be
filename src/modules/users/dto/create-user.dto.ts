import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/users. `.strict()` rejects unknown fields, which
 * blocks accidental mass-assignment from clients sending extra keys.
 */
export const CreateUserSchema = z
  .object({
    email: z.email().max(255),
    fullName: z.string().trim().min(1).max(120),
    password: z.string().min(12).max(128),
    role: z.enum(['admin', 'staff', 'customer']).default('customer'),
  })
  .strict();

export type CreateUserInput = z.infer<typeof CreateUserSchema>;

export class CreateUserDto extends createZodDto(CreateUserSchema) {}
