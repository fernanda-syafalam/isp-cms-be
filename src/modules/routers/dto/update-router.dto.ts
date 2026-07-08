import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for PATCH /v1/routers/:id. Every field is optional (partial patch);
 * an absent field leaves the stored value unchanged.
 *
 * SEC-M1: changing `host` re-points where the shared/legacy fallback
 * credential (and, once migrated, the per-router credential) gets dialed —
 * `RoutersService.update` logs a security-relevant warning whenever `host`
 * actually changes so a malicious swap is visible/alertable, in addition to
 * the `@Audit('router.update')` entry the controller already records.
 *
 * `password`, like on connect, is persisted only as the encrypted
 * `apiPasswordEncrypted` column and is never returned by any response.
 */
export const UpdateRouterSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    host: z.string().trim().min(1).max(120).optional(),
    apiPort: z.number().int().min(1).max(65535).optional(),
    username: z.string().trim().min(1).max(60).optional(),
    apiUsername: z.string().trim().min(1).max(60).optional(),
    password: z.string().min(1).max(120).optional(),
  })
  .strict();

export type UpdateRouterInput = z.infer<typeof UpdateRouterSchema>;

export class UpdateRouterDto extends createZodDto(UpdateRouterSchema) {}
