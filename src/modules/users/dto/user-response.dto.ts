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

/**
 * Cursor-paginated list response for `GET /v1/users`. Binding this via
 * `@ZodSerializerDto` closes the same strip-guard gap `UserResponseDto`
 * closes for the single-record endpoints — today it's a no-op (the handler
 * already field-strips + ISO-converts by hand), but it guards against a
 * future sensitive column added to `users` leaking through the list.
 */
export const UserListResponseSchema = z.object({
  items: z.array(UserResponseSchema),
  nextCursor: z.string().nullable(),
});

export type UserListResponse = z.infer<typeof UserListResponseSchema>;

export class UserListResponseDto extends createZodDto(UserListResponseSchema) {}
