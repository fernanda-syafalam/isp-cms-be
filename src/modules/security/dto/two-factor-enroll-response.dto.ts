import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output for POST /v1/security/2fa/enroll — enough for the FE to render
 * a QR code (`otpauthUri`) plus a manual-entry fallback (`twoFactorSecret`).
 * `twoFactorEnabled` stays false until `/2fa/confirm` succeeds; the secret
 * alone never gates login (see SecurityService.beginEnroll).
 *
 * Field is named `twoFactorSecret` (not the generic `secret`) so the pino
 * redact wildcard in AppLoggerModule can target it unambiguously without
 * colliding with unrelated `secret` fields elsewhere (e.g. PPPoE secrets).
 */
export const TwoFactorEnrollResponseSchema = z.object({
  twoFactorSecret: z.string(),
  otpauthUri: z.string(),
});
export type TwoFactorEnrollResponse = z.infer<typeof TwoFactorEnrollResponseSchema>;
export class TwoFactorEnrollResponseDto extends createZodDto(TwoFactorEnrollResponseSchema) {}
