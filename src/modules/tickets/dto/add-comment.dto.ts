import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Input for POST /v1/tickets/:id/comments. */
export const AddCommentSchema = z
  .object({
    body: z.string().trim().min(1).max(500),
  })
  .strict();

export type AddCommentInput = z.infer<typeof AddCommentSchema>;

export class AddCommentDto extends createZodDto(AddCommentSchema) {}
