import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/security/2fa/enable. The FE validates the same 6-digit
 * shape before sending (with a Bahasa message); this guards the boundary.
 */
export const EnableTwoFactorSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  })
  .strict();
export type EnableTwoFactorInput = z.infer<typeof EnableTwoFactorSchema>;
export class EnableTwoFactorDto extends createZodDto(EnableTwoFactorSchema) {}
