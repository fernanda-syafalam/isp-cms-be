import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/routers (connect) and POST /v1/routers/test-connection.
 *
 * SEC-M1: `password` is now persisted as the router's own per-router
 * credential — encrypted at rest (AES-256-GCM) by `RouterCredentialCipherService`
 * — instead of only probing the device and being discarded. It is never
 * returned by any response (see `RouterResponseSchema`).
 */
export const ConnectRouterSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    host: z.string().trim().min(1).max(120),
    apiPort: z.number().int().min(1).max(65535),
    username: z.string().trim().min(1).max(60),
    // Optional distinct RouterOS API login user (e.g. a dedicated,
    // minimally-privileged API account). Falls back to `username` when unset.
    apiUsername: z.string().trim().min(1).max(60).optional(),
    password: z.string().min(1).max(120),
    useTls: z.boolean(),
  })
  .strict();

export type ConnectRouterInput = z.infer<typeof ConnectRouterSchema>;

export class ConnectRouterDto extends createZodDto(ConnectRouterSchema) {}
