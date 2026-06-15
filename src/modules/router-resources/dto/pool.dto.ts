import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for POST /v1/routers/:routerId/pools. */
export const CreatePoolSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    ranges: z.string().trim().min(1).max(120),
  })
  .strict();

export type CreatePoolInput = z.infer<typeof CreatePoolSchema>;
export class CreatePoolDto extends createZodDto(CreatePoolSchema) {}

/** Output shape for an IP pool. */
export const PoolResponseSchema = z.object({
  id: z.uuid(),
  routerId: z.uuid(),
  name: z.string(),
  ranges: z.string(),
  totalAddresses: z.number().int().nonnegative(),
  usedAddresses: z.number().int().nonnegative(),
});
export type PoolResponse = z.infer<typeof PoolResponseSchema>;
export class PoolResponseDto extends createZodDto(PoolResponseSchema) {}
