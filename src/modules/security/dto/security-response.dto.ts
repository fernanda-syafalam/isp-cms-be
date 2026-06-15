import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** One reviewable login session — mirrors the FE `SecuritySessionSchema`. */
export const SecuritySessionResponseSchema = z.object({
  id: z.string(),
  device: z.string(),
  ip: z.string(),
  lastActiveAt: z.iso.datetime(),
  current: z.boolean(),
});
export type SecuritySessionResponse = z.infer<typeof SecuritySessionResponseSchema>;

/** The current user's security state — mirrors the FE `SecurityStateSchema`. */
export const SecurityStateResponseSchema = z.object({
  twoFactorEnabled: z.boolean(),
  sessions: z.array(SecuritySessionResponseSchema),
});
export type SecurityStateResponse = z.infer<typeof SecurityStateResponseSchema>;
export class SecurityStateResponseDto extends createZodDto(SecurityStateResponseSchema) {}
