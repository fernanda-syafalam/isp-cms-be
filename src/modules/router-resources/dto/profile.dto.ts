import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for POST /v1/routers/:routerId/profiles. */
export const CreateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    rateLimit: z.string().trim().min(1).max(40),
  })
  .strict();

export type CreateProfileInput = z.infer<typeof CreateProfileSchema>;
export class CreateProfileDto extends createZodDto(CreateProfileSchema) {}

/** Input for PATCH /v1/routers/:routerId/profiles/:pid. */
export const UpdateProfileSchema = CreateProfileSchema.partial();
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;
export class UpdateProfileDto extends createZodDto(UpdateProfileSchema) {}

/** Output shape for a PPPoE profile. */
export const ProfileResponseSchema = z.object({
  id: z.uuid(),
  routerId: z.uuid(),
  name: z.string(),
  rateLimit: z.string(),
  isIsolir: z.boolean(),
});
export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;
export class ProfileResponseDto extends createZodDto(ProfileResponseSchema) {}
