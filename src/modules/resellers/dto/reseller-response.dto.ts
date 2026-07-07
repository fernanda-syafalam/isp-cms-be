import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Output shape for a reseller. customerCount is derived (by resellerId FK match). */
export const ResellerResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  area: z.string(),
  balance: z.number().int().nonnegative(),
  commissionPct: z.number().nonnegative(),
  customerCount: z.number().int().nonnegative(),
  status: z.enum(['active', 'inactive']),
});

export type ResellerResponse = z.infer<typeof ResellerResponseSchema>;

export class ResellerResponseDto extends createZodDto(ResellerResponseSchema) {}

/**
 * Full-set status-count + balance rollup for the reseller list. Computed
 * over ALL resellers — NEVER affected by status/q/paging (mirrors the
 * work-orders/invoices summary aggregate, FE contract parity). Every status
 * key is always present (zero-filled).
 */
export const ResellerSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  totalBalance: z.number().int().nonnegative(),
  byStatus: z.object({
    active: z.number().int().nonnegative(),
    inactive: z.number().int().nonnegative(),
  }),
});

export type ResellerSummary = z.infer<typeof ResellerSummarySchema>;

/**
 * Paginated list response for GET /v1/resellers.
 *
 * - `items`   – current page (after status/q filter, sort, limit/offset).
 * - `total`   – count matching the current filter BEFORE paging.
 * - `summary` – full-set aggregate; NEVER affected by any filter or paging.
 */
export const ResellerListResponseSchema = z.object({
  items: z.array(ResellerResponseSchema),
  total: z.number().int().nonnegative(),
  summary: ResellerSummarySchema,
});

export type ResellerListResponse = z.infer<typeof ResellerListResponseSchema>;

export class ResellerListResponseDto extends createZodDto(ResellerListResponseSchema) {}

/** Output shape for a ledger entry (amount is signed). */
export const LedgerEntryResponseSchema = z.object({
  id: z.uuid(),
  resellerId: z.uuid(),
  type: z.enum(['topup', 'commission', 'deduction', 'withdrawal']),
  amount: z.number().int(),
  note: z.string(),
  balanceAfter: z.number().int().nonnegative(),
  at: z.iso.datetime(),
});

export type LedgerEntryResponse = z.infer<typeof LedgerEntryResponseSchema>;

export class LedgerEntryResponseDto extends createZodDto(LedgerEntryResponseSchema) {}
