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

/**
 * Full-set status-count rollup for the router list. Computed over ALL
 * routers — NEVER affected by status/q/paging (mirrors the
 * work-orders/invoices summary aggregate, FE contract parity). Every status
 * key is always present (zero-filled).
 */
export const RouterSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.object({
    online: z.number().int().nonnegative(),
    offline: z.number().int().nonnegative(),
  }),
});

export type RouterSummary = z.infer<typeof RouterSummarySchema>;

/**
 * Paginated list response for GET /v1/routers.
 *
 * - `items`   – current page (after status/q filter, sort, limit/offset).
 * - `total`   – count matching the current filter BEFORE paging.
 * - `summary` – full-set aggregate; NEVER affected by any filter or paging.
 */
export const RouterListResponseSchema = z.object({
  items: z.array(RouterResponseSchema),
  total: z.number().int().nonnegative(),
  summary: RouterSummarySchema,
});

export type RouterListResponse = z.infer<typeof RouterListResponseSchema>;

export class RouterListResponseDto extends createZodDto(RouterListResponseSchema) {}

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
