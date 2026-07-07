import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const LoginSchema = z
  .object({
    email: z.email(),
    password: z.string().min(1).max(128),
    // Only consulted server-side when the account has confirmed 2FA
    // (ADR-0002). Omitted/blank on a 2FA account yields `totp_required`,
    // not silently ignored.
    totpCode: z
      .string()
      .regex(/^\d{6}$/, 'code must be 6 digits')
      .optional(),
  })
  .strict();

export type LoginInput = z.infer<typeof LoginSchema>;

export class LoginDto extends createZodDto(LoginSchema) {}
