import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Output shape for a plan. `subscriberCount` is computed at list time
 * (how many active customers are on the plan) and is optional — single
 * mutation responses omit it. `@ZodSerializerDto` strips anything not
 * declared here.
 */
export const PlanResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  speedMbps: z.number().int(),
  priceMonthly: z.number().int(),
  status: z.enum(['active', 'archived']),
  subscriberCount: z.number().int().nonnegative().optional(),
});

export type PlanResponse = z.infer<typeof PlanResponseSchema>;

export class PlanResponseDto extends createZodDto(PlanResponseSchema) {}

/**
 * Full-set status-count + subscriber rollup for the plan catalog list.
 * Computed over ALL plans — NEVER affected by q/paging (mirrors the
 * work-orders/invoices summary aggregate, FE contract parity).
 * `totalSubscribers` is the count of active ('aktif') customers across the
 * whole subscriber base (not scoped to a single plan) — the same
 * `customers.aktif` figure the analytics dashboard KPI uses.
 */
export const PlanSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  totalSubscribers: z.number().int().nonnegative(),
  byStatus: z.object({
    active: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
  }),
});

export type PlanSummary = z.infer<typeof PlanSummarySchema>;

/**
 * Paginated list response for GET /v1/plans.
 *
 * - `items`   – current page (after q filter, sort, limit/offset).
 * - `total`   – count matching the current q filter BEFORE paging.
 * - `summary` – full-set aggregate; NEVER affected by q or paging.
 */
export const PlanListResponseSchema = z.object({
  items: z.array(PlanResponseSchema),
  total: z.number().int().nonnegative(),
  summary: PlanSummarySchema,
});

export type PlanListResponse = z.infer<typeof PlanListResponseSchema>;

export class PlanListResponseDto extends createZodDto(PlanListResponseSchema) {}
