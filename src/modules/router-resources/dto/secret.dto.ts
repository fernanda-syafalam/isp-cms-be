import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for POST /v1/routers/:routerId/secrets. password is not persisted. */
export const CreateSecretSchema = z
  .object({
    username: z.string().trim().min(1).max(60),
    password: z.string().min(1).max(60),
    profileId: z.uuid(),
    customerName: z.string().trim().max(120).optional(),
    comment: z.string().trim().max(160).optional(),
  })
  .strict();

export type CreateSecretInput = z.infer<typeof CreateSecretSchema>;
export class CreateSecretDto extends createZodDto(CreateSecretSchema) {}

/** Input for PATCH /v1/routers/:routerId/secrets/:sid. */
export const UpdateSecretSchema = z
  .object({
    username: z.string().trim().min(1).max(60).optional(),
    password: z.string().min(1).max(60).optional(),
    profileId: z.uuid().optional(),
    customerName: z.string().trim().max(120).nullable().optional(),
    comment: z.string().trim().max(160).nullable().optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

export type UpdateSecretInput = z.infer<typeof UpdateSecretSchema>;
export class UpdateSecretDto extends createZodDto(UpdateSecretSchema) {}

/**
 * Base output shape for a PPPoE secret.
 * POST and PATCH return this shape — no live-connection fields.
 */
export const SecretResponseSchema = z.object({
  id: z.uuid(),
  routerId: z.uuid(),
  username: z.string(),
  profileId: z.uuid(),
  profileName: z.string(),
  customerId: z.uuid().nullable(),
  customerName: z.string().nullable(),
  disabled: z.boolean(),
  comment: z.string().nullable(),
});
export type SecretResponse = z.infer<typeof SecretResponseSchema>;
export class SecretResponseDto extends createZodDto(SecretResponseSchema) {}

/**
 * List-item shape — extends the base with inline live-connection fields.
 * These fields are a LIST-ONLY projection; POST/PATCH never include them.
 *
 * - online:    derived as !disabled (sessions are 1:1 with enabled secrets)
 * - address:   synthesised assigned IP when online, null otherwise
 * - uptime:    synthesised uptime string when online, null otherwise
 * - sessionId: equals secret.id when online (session = secret), null otherwise
 */
export const SecretListItemSchema = SecretResponseSchema.extend({
  online: z.boolean(),
  address: z.string().nullable(),
  uptime: z.string().nullable(),
  sessionId: z.string().nullable(),
});
export type SecretListItem = z.infer<typeof SecretListItemSchema>;

/** Paginated list response for GET /v1/routers/:routerId/secrets. */
export const SecretListResponseSchema = z.object({
  items: z.array(SecretListItemSchema),
  total: z.number().int().nonnegative(),
});
export type SecretListResponse = z.infer<typeof SecretListResponseSchema>;
export class SecretListResponseDto extends createZodDto(SecretListResponseSchema) {}
