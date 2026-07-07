import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for an SLA credit. */
export const SlaCreditResponseSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid().nullable(),
  customerName: z.string(),
  amount: z.number().int().nonnegative(),
  reason: z.string(),
  ticketId: z.uuid().nullable(),
  ticketCode: z.string().nullable(),
  status: z.enum(['pending', 'applied', 'void']),
  createdAt: z.iso.datetime(),
  appliedAt: z.iso.datetime().nullable(),
});

export type SlaCreditResponse = z.infer<typeof SlaCreditResponseSchema>;

export class SlaCreditResponseDto extends createZodDto(SlaCreditResponseSchema) {}

/**
 * Full-set summary aggregate for the SLA credits list.
 * Computed over ALL sla_credits — NEVER affected by q/paging.
 *
 * - total:        count of ALL credits (every status).
 * - activeAmount: sum of `amount` for credits whose status != 'void'.
 * - pending:      count of credits with status 'pending'.
 * - applied:      count of credits with status 'applied'.
 * - void:         count of credits with status 'void'.
 */
export const SlaCreditSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  activeAmount: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  void: z.number().int().nonnegative(),
});

export type SlaCreditSummary = z.infer<typeof SlaCreditSummarySchema>;

/**
 * Paginated list response for GET /v1/sla-credits.
 *
 * - `items`   – current page (after q filter, sort, limit/offset).
 * - `total`   – count matching q filter BEFORE paging (drives page count).
 * - `summary` – full-set aggregate; NEVER affected by q/paging.
 */
export const SlaCreditListResponseSchema = z.object({
  items: z.array(SlaCreditResponseSchema),
  total: z.number().int().nonnegative(),
  summary: SlaCreditSummarySchema,
});

export type SlaCreditListResponse = z.infer<typeof SlaCreditListResponseSchema>;

export class SlaCreditListResponseDto extends createZodDto(SlaCreditListResponseSchema) {}
