import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Input for POST /v1/routers (connect) and POST /v1/routers/test-connection.
 * `password` is used to probe the device and is NOT persisted.
 */
export const ConnectRouterSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    host: z.string().trim().min(1).max(120),
    apiPort: z.number().int().min(1).max(65535),
    username: z.string().trim().min(1).max(60),
    password: z.string().min(1).max(120),
    useTls: z.boolean(),
  })
  .strict();

export type ConnectRouterInput = z.infer<typeof ConnectRouterSchema>;

export class ConnectRouterDto extends createZodDto(ConnectRouterSchema) {}
