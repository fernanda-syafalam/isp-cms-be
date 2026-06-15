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

/** Output shape for a PPPoE secret. */
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
