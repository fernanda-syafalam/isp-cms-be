import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output shape for an active PPPoE session (derived from enabled secrets).
 * Includes 3 fields denormalized from the parent secret so the frontend
 * never needs to fetch secrets to show customer/profile info per session.
 */
export const SessionResponseSchema = z.object({
  id: z.uuid(),
  routerId: z.uuid(),
  username: z.string(),
  address: z.string(),
  uptime: z.string(),
  callerId: z.string(),
  // Denormalized from the secret this session derives from:
  customerId: z.string().nullable(),
  customerName: z.string().nullable(),
  profileName: z.string(),
});

export type SessionResponse = z.infer<typeof SessionResponseSchema>;
export class SessionResponseDto extends createZodDto(SessionResponseSchema) {}

/** Paginated list response for GET /v1/routers/:routerId/sessions. */
export const SessionListResponseSchema = z.object({
  items: z.array(SessionResponseSchema),
  total: z.number().int().nonnegative(),
});
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
export class SessionListResponseDto extends createZodDto(SessionListResponseSchema) {}
