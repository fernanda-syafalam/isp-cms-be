import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a voucher. */
export const VoucherResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  batchId: z.string(),
  profile: z.string(),
  priceIdr: z.number().int().nonnegative(),
  durationDays: z.number().int().positive(),
  status: z.enum(['unused', 'used', 'expired']),
  usedAt: z.iso.datetime().nullable(),
  usedBy: z.string().nullable(),
  // Attributed mitra (P3.D.3) — null for house-minted / walk-in stock.
  resellerId: z.uuid().nullable(),
  resellerName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export type VoucherResponse = z.infer<typeof VoucherResponseSchema>;

export class VoucherResponseDto extends createZodDto(VoucherResponseSchema) {}

/**
 * Full-set summary aggregate for the vouchers list.
 * Computed over ALL vouchers — NEVER affected by status/q/paging.
 */
export const VoucherSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  unused: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  revenue: z.number().int().nonnegative(),
});

export type VoucherSummary = z.infer<typeof VoucherSummarySchema>;

/**
 * Paginated list response for GET /v1/vouchers.
 *
 * - `items`   – current page (after status + q filter, sort, limit/offset).
 * - `total`   – count matching status+q filter BEFORE paging (drives page count).
 * - `summary` – full-set aggregate; NEVER affected by status/q/paging.
 */
export const VoucherListResponseSchema = z.object({
  items: z.array(VoucherResponseSchema),
  total: z.number().int().nonnegative(),
  summary: VoucherSummarySchema,
});

export type VoucherListResponse = z.infer<typeof VoucherListResponseSchema>;

export class VoucherListResponseDto extends createZodDto(VoucherListResponseSchema) {}

/** Result of a batch mint. */
export const BatchResultSchema = z.object({
  batchId: z.string(),
  created: z.number().int().nonnegative(),
});

export type BatchResult = z.infer<typeof BatchResultSchema>;

export class BatchResultDto extends createZodDto(BatchResultSchema) {}
