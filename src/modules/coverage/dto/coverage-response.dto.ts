import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a coverage area / POP. */
export const CoverageResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(['pop', 'area']),
  region: z.string(),
  capacity: z.number().int().nonnegative(),
  activeConnections: z.number().int().nonnegative(),
  status: z.enum(['operational', 'maintenance', 'down']),
});

export type CoverageResponse = z.infer<typeof CoverageResponseSchema>;

export class CoverageResponseDto extends createZodDto(CoverageResponseSchema) {}

/**
 * Full-set status-count rollup for the coverage list. Computed over ALL
 * coverage areas — NEVER affected by status/type/q/paging (mirrors the
 * work-orders/invoices summary aggregate, FE contract parity). Every status
 * key is always present (zero-filled).
 */
export const CoverageSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.object({
    operational: z.number().int().nonnegative(),
    maintenance: z.number().int().nonnegative(),
    down: z.number().int().nonnegative(),
  }),
});

export type CoverageSummary = z.infer<typeof CoverageSummarySchema>;

/**
 * Paginated list response for GET /v1/coverage.
 *
 * - `items`   – current page (after status/type/q filter, sort, limit/offset).
 * - `total`   – count matching the current filter BEFORE paging.
 * - `summary` – full-set aggregate; NEVER affected by any filter or paging.
 */
export const CoverageListResponseSchema = z.object({
  items: z.array(CoverageResponseSchema),
  total: z.number().int().nonnegative(),
  summary: CoverageSummarySchema,
});

export type CoverageListResponse = z.infer<typeof CoverageListResponseSchema>;

export class CoverageListResponseDto extends createZodDto(CoverageListResponseSchema) {}
