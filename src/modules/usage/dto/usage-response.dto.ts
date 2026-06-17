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

/**
 * Full-set aggregate computed over ALL usage rows regardless of q/sort/paging.
 * Stays identical under any filter — it is the fleet-wide FUP snapshot.
 */
export const UsageSummarySchema = z.object({
  /** Sum of usedGb over all provisioned subscribers (integer). */
  totalUsedGb: z.number().int().nonnegative(),
  /** Count of subscribers where fupThrottled is true (integer). */
  throttled: z.number().int().nonnegative(),
  /** Math.round(totalUsedGb / rowCount) — 0 when there are no rows (integer). */
  avgUsedGb: z.number().int().nonnegative(),
});

export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export class UsageSummaryDto extends createZodDto(UsageSummarySchema) {}
