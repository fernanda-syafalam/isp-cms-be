import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for POST /v1/routers/:routerId/queues. */
export const CreateQueueSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    target: z.string().trim().min(1).max(60),
    maxLimit: z.string().trim().min(1).max(40),
  })
  .strict();

export type CreateQueueInput = z.infer<typeof CreateQueueSchema>;
export class CreateQueueDto extends createZodDto(CreateQueueSchema) {}

/** Input for PATCH /v1/routers/:routerId/queues/:id. */
export const UpdateQueueSchema = CreateQueueSchema.partial();
export type UpdateQueueInput = z.infer<typeof UpdateQueueSchema>;
export class UpdateQueueDto extends createZodDto(UpdateQueueSchema) {}

/** Output shape for a simple queue. */
export const QueueResponseSchema = z.object({
  id: z.uuid(),
  routerId: z.uuid(),
  name: z.string(),
  target: z.string(),
  maxLimit: z.string(),
});
export type QueueResponse = z.infer<typeof QueueResponseSchema>;
export class QueueResponseDto extends createZodDto(QueueResponseSchema) {}

/** Paginated list response for GET /v1/routers/:routerId/queues. */
export const QueueListResponseSchema = z.object({
  items: z.array(QueueResponseSchema),
  total: z.number().int().nonnegative(),
});
export type QueueListResponse = z.infer<typeof QueueListResponseSchema>;
export class QueueListResponseDto extends createZodDto(QueueListResponseSchema) {}
