import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a router. The API password is never returned. */
export const RouterResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  address: z.string(),
  apiPort: z.number().int(),
  username: z.string(),
  model: z.string(),
  version: z.string(),
  status: z.enum(['online', 'offline']),
  secretCount: z.number().int().nonnegative(),
  lastSyncAt: z.iso.datetime(),
});

export type RouterResponse = z.infer<typeof RouterResponseSchema>;

export class RouterResponseDto extends createZodDto(RouterResponseSchema) {}

/** Result of a connection probe (no persistence). */
export const TestConnectionResultSchema = z.object({
  ok: z.boolean(),
  identity: z.string().nullable(),
  model: z.string().nullable(),
  version: z.string().nullable(),
  message: z.string().nullable(),
});

export type TestConnectionResult = z.infer<typeof TestConnectionResultSchema>;

export class TestConnectionResultDto extends createZodDto(TestConnectionResultSchema) {}
