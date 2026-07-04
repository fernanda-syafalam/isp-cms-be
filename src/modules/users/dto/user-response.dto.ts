import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output shape for any endpoint that returns a single user. The schema
 * deliberately omits `passwordHash` and `deletedAt` — when bound via
 * `@ZodSerializerDto`, anything not declared here is stripped from the
 * response, which is the last line of defence against leaking
 * sensitive fields. See Pilar 2.
 */
export const UserResponseSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  fullName: z.string(),
  role: z.enum(['admin', 'staff', 'customer', 'teknisi', 'mitra']),
  createdAt: z.iso.datetime(),
});

export type UserResponse = z.infer<typeof UserResponseSchema>;

export class UserResponseDto extends createZodDto(UserResponseSchema) {}
