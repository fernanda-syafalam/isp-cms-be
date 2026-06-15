import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output shape for a subscriber's data-usage record. quotaGb 0 = unlimited;
 * fupThrottled is true when quotaGb > 0 and usedGb >= quotaGb. trend is the
 * last 7 days of daily GB.
 */
export const UsageResponseSchema = z.object({
  customerId: z.uuid(),
  customerName: z.string(),
  planName: z.string(),
  quotaGb: z.number().int().nonnegative(),
  usedGb: z.number().int().nonnegative(),
  fupThrottled: z.boolean(),
  trend: z.array(z.number().int().nonnegative()).length(7),
});

export type UsageResponse = z.infer<typeof UsageResponseSchema>;

export class UsageResponseDto extends createZodDto(UsageResponseSchema) {}
