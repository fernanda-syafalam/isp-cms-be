import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/security/2fa/disable. `code` is only required when
 * 2FA is currently enabled (SecurityService enforces this — an
 * in-progress, unconfirmed enrollment can be cancelled without a code
 * since it never gated login). Optional here so the DTO shape does not
 * force the FE to fabricate a code for that case.
 *
 * `.default({})` at the root: Fastify hands `@Body()` as `undefined` when
 * the client sends no body/content-type at all (see main.ts — a
 * `Content-Type: application/json` header with a truly empty body is
 * rejected by Fastify itself before this DTO ever runs). Defaulting the
 * whole object lets a client legitimately POST with no body when it has
 * no code to send, instead of being forced to send `{}` explicitly.
 */
export const DisableTwoFactorSchema = z
  .object({
    code: z
      .string()
      .regex(/^\d{6}$/, 'code must be 6 digits')
      .optional(),
  })
  .strict()
  .default({});
export type DisableTwoFactorInput = z.infer<typeof DisableTwoFactorSchema>;
export class DisableTwoFactorDto extends createZodDto(DisableTwoFactorSchema) {}
