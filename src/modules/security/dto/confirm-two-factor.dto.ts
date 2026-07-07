import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/security/2fa/confirm — the code from the
 * authenticator app the user just scanned via `/2fa/enroll`. The FE
 * validates the same 6-digit shape before sending (with a Bahasa
 * message); this guards the boundary.
 */
export const ConfirmTwoFactorSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  })
  .strict();
export type ConfirmTwoFactorInput = z.infer<typeof ConfirmTwoFactorSchema>;
export class ConfirmTwoFactorDto extends createZodDto(ConfirmTwoFactorSchema) {}
