import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const RefreshTokenSchema = z
  .object({
    refreshToken: z.string().min(1).max(512),
  })
  .strict();

export type RefreshTokenInput = z.infer<typeof RefreshTokenSchema>;

export class RefreshTokenDto extends createZodDto(RefreshTokenSchema) {}
