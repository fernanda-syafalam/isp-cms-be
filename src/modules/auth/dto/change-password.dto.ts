import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/auth/change-password (self-service, any role). The
 * current password is re-verified even though the caller holds a valid
 * JWT — a stolen session must not be able to rotate the credential and
 * lock the owner out. Same length policy as CreateUserSchema.
 */
export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(12).max(128),
  })
  .strict();

export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

export class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}
